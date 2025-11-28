
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  DynamoDBClient
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  QueryCommand
} = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-2';
const TABLE = process.env.TODOS_TABLE;
const INDEX = process.env.TODOS_INDEX_NAME; // UserIdCreatedAtIndex
const BUCKET = process.env.ATTACHMENTS_BUCKET;
const EXP = parseInt(process.env.SIGNED_URL_EXPIRATION || '300', 10);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': true
};

function getUserId(event) {
  try {
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
  console.log('getTodos event:', JSON.stringify(event));

  try {
    const userId = getUserId(event);
    if (!userId) {
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ message: 'Unauthorized' }) };
    }

    // Query the GSI by userId (efficient; no Scan)
    const resp = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: INDEX,
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ScanIndexForward: true // oldest->newest; set false if you want newest first
    }));

    const items = resp.Items || [];

    
    for (const item of items) {
      if (item.attachmentKey) {
        try {
          const getCmd = new GetObjectCommand({
            Bucket: BUCKET,
            Key: item.attachmentKey
          });
          item.attachmentUrl = await getSignedUrl(s3, getCmd, { expiresIn: EXP });
        } catch (e) {
          console.warn('Failed to create signed GET URL for', item.attachmentKey, e);
          // Leave attachmentUrl undefined if signing fails
        }
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ items })
    };
  } catch (err) {
    console.error('getTodos error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Failed to fetch todos' })
    };
  }
};
