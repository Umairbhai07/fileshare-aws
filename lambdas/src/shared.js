import { createFileService } from '@fileshare/core';
import { createDynamoRepo, createS3Storage } from '@fileshare/core/aws';

export const log = (event, data = {}) => console.log(JSON.stringify({ level: 'info', event, ...data }));

/**
 * CloudWatch Embedded Metric Format: printing this JSON creates custom metrics
 * (namespace FileShare) with no PutMetricData calls.
 */
export function metric(name, value, unit = 'Count') {
  console.log(JSON.stringify({
    _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'FileShare', Dimensions: [[]], Metrics: [{ Name: name, Unit: unit }] }] },
    [name]: value,
  }));
}

let service;
export function getService() {
  service ??= createFileService({
    repo: createDynamoRepo({ tableName: process.env.TABLE_NAME }),
    storage: createS3Storage({ bucket: process.env.FILES_BUCKET }),
    log,
  });
  return service;
}
export const setService = (s) => { service = s; };
