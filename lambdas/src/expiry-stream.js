// DynamoDB Streams (REMOVE events, e.g. from TTL expiry) -> Lambda: deletes the S3 object.
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { getService, metric } from './shared.js';

export async function handler(event) {
  const service = getService();
  const batchItemFailures = [];
  for (const record of event.Records || []) {
    if (record.eventName !== 'REMOVE' || !record.dynamodb?.OldImage) continue;
    try {
      const old = unmarshall(record.dynamodb.OldImage);
      if (await service.onItemRemoved(old)) {
        const byTtl = record.userIdentity?.principalId === 'dynamodb.amazonaws.com';
        metric(byTtl ? 'FilesExpiredByTtl' : 'FilesRemoved', 1);
      }
    } catch (err) {
      console.error(JSON.stringify({ level: 'error', message: err.message }));
      batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
    }
  }
  return { batchItemFailures };
}
