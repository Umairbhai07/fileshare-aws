// AWS adapters: DynamoDB repository + S3 storage with presigned URLs.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const userKey = (ownerId) => `user#${ownerId}`;

export function createDynamoRepo({ tableName, client }) {
  const ddb = DynamoDBDocumentClient.from(client || new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const conditional = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') return null;
      throw err;
    }
  };

  return {
    async put(item) {
      await ddb.send(new PutCommand({ TableName: tableName, Item: item, ConditionExpression: 'attribute_not_exists(id)' }));
    },
    async get(id) {
      const res = await ddb.send(new GetCommand({ TableName: tableName, Key: { id } }));
      return res.Item || null;
    },
    async delete(id) {
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: { id } }));
    },
    async listByOwner(ownerId) {
      const out = [];
      let ExclusiveStartKey;
      do {
        const res = await ddb.send(new QueryCommand({
          TableName: tableName,
          IndexName: 'byOwner',
          KeyConditionExpression: 'ownerId = :o',
          ExpressionAttributeValues: { ':o': ownerId },
          ScanIndexForward: false,
          ExclusiveStartKey,
        }));
        out.push(...(res.Items || []));
        ExclusiveStartKey = res.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },
    async update(id, fields) {
      const names = {};
      const values = {};
      const sets = Object.entries(fields).map(([k, v], i) => {
        names[`#f${i}`] = k;
        values[`:v${i}`] = v;
        return `#f${i} = :v${i}`;
      });
      return conditional(async () => (await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { id },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(id)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }))).Attributes);
    },
    async markReady(id, size, now) {
      return conditional(async () => (await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { id },
        UpdateExpression: 'SET #s = :ready, #size = :size, uploadedAt = :now',
        ConditionExpression: 'attribute_exists(id) AND #s = :pending',
        ExpressionAttributeNames: { '#s': 'status', '#size': 'size' },
        ExpressionAttributeValues: { ':ready': 'ready', ':pending': 'pending', ':size': size, ':now': now },
        ReturnValues: 'ALL_NEW',
      }))).Attributes);
    },
    async incrementDownloads(id, now) {
      return conditional(async () => (await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { id },
        UpdateExpression: 'ADD downloads :one SET lastDownloadAt = :now',
        ConditionExpression: '#s = :ready AND expiresAt > :now AND (maxDownloads = :zero OR downloads < maxDownloads)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':one': 1, ':now': now, ':ready': 'ready', ':zero': 0 },
        ReturnValues: 'ALL_NEW',
      }))).Attributes);
    },
    async scanExpired(now, pendingBefore) {
      const out = [];
      let ExclusiveStartKey;
      do {
        const res = await ddb.send(new ScanCommand({
          TableName: tableName,
          FilterExpression: 'attribute_exists(ownerId) AND (expiresAt <= :now OR (#s = :pending AND createdAt < :pb))',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':now': now, ':pending': 'pending', ':pb': pendingBefore },
          ExclusiveStartKey,
        }));
        out.push(...(res.Items || []));
        ExclusiveStartKey = res.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },
    async bumpUserStats(ownerId, delta) {
      const names = {};
      const values = {};
      const parts = Object.entries(delta).map(([k, v], i) => {
        names[`#k${i}`] = k;
        values[`:v${i}`] = v;
        return `#k${i} :v${i}`;
      });
      await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: { id: userKey(ownerId) },
        UpdateExpression: `ADD ${parts.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }));
    },
    async getUserStats(ownerId) {
      const res = await ddb.send(new GetCommand({ TableName: tableName, Key: { id: userKey(ownerId) } }));
      return res.Item || null;
    },
  };
}

export function createS3Storage({ bucket, client }) {
  const s3 = client || new S3Client({});
  return {
    async presignPut(key, size, contentType) {
      // ContentLength is signed, so the browser can only upload exactly the size it declared.
      return getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: size }), {
        expiresIn: 900,
        signableHeaders: new Set(['content-type', 'content-length']),
      });
    },
    async presignGet(key, name, contentType, opts = {}) {
      const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      return getSignedUrl(s3, new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: `${opts.inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encoded}`,
        ResponseContentType: contentType || 'application/octet-stream',
      }), { expiresIn: 300 });
    },
    async head(key) {
      try {
        const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: res.ContentLength };
      } catch (err) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
