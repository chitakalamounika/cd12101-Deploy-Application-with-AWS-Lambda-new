

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  DynamoDBClient
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand
} = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-2';
const TABLE = process.env.TODOS_TABLE;
const BUCKET = process.env.ATTACHMENTS_BUCKET;
const EXP = parseInt(process.env.SIGNED_URL_EXPIRATION || '300', 10);

const s3 = new S3Client({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true }
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': true
};

// Try to extract userId from API Gateway authorizer
function getUserId(event) {
  try {
    // Common shapes from custom authorizer/JWT
    return (
      (event.requestContext &&
        event.requestContext.authorizer &&
        (event.requestContext.authorizer.principalId ||
         (event.requestContext.authorizer.claims && event.requestContext.authorizer.claims.sub))) ||
      null
    );
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  console.log('generateUploadUrl event:', JSON.stringify(event));

  try {
    const userId = getUserId(event);
    const todoId = event.pathParameters && event.pathParameters.todoId;

    if (!userId) {
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ message: 'Unauthorized' }) };
    }
    if (!todoId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ message: 'Missing todoId path parameter' }) };
    }

    // Optional safety: verify this todo exists and belongs to userId
    const getResp = await ddb.send(new GetCommand({
      TableName: TABLE,
      Key: { userId, todoId }
    }));
    if (!getResp.Item) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ message: 'Todo not found' }) };
    }

    
    const key = `${userId}/${todoId}`;

   
    const putCmd = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key
      // You may allow content-type validation on client side; add ContentType here if you enforce it
    });
    const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: EXP });

    // Save the attachment key (not a public URL)
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { userId, todoId },
      UpdateExpression: 'SET attachmentKey = :k',
      ExpressionAttributeValues: { ':k': key }
    }));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ uploadUrl })
    };
  } catch (err) {
    console.error('generateUploadUrl error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Failed to generate upload URL' })
    };
  }
};
