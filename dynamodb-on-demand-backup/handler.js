import {DynamoDB} from 'aws-sdk';

// Configurations
const BACKUP_TABLES = process.env.TABLES.split(',');
const BACKUP_RETENTION = parseInt(process.env.BACKUP_RETENTION) || 7 * 86400; // in seconds should > 0
const BACKUP_MIN_COUNT = parseInt(process.env.BACKUP_MIN_COUNT) || 7; // in seconds should > 0

// DynamoDB Client Instance
const dynamo = new DynamoDB({
  apiVersion: '2012-08-10',
  region: 'ap-northeast-1',
});

/**
 * Get Backup's Outdated Datetime Boundary
 * @return {Date}
 */
const getOutdatedBoundary = () => {
  if (!Number.isInteger(BACKUP_RETENTION) || BACKUP_RETENTION < 1)
    throw new Error('Backup Retention should be larger than 0.');

  const time = new Date();

  const deltaDays = Math.floor(BACKUP_RETENTION / 86400);
  const deltaHours = Math.floor((BACKUP_RETENTION - deltaDays * 86400) / 3600);
  const deltaMinutes = Math.floor((BACKUP_RETENTION - deltaDays * 86400 - deltaHours * 3600) / 60);
  const deltaSeconds = Math.floor(BACKUP_RETENTION - deltaDays * 86400 - deltaHours * 3600 - deltaMinutes * 60);

  time.setDate(time.getDate() - deltaDays);
  time.setHours(time.getHours() - deltaHours, time.getMinutes() - deltaMinutes, time.getSeconds() - deltaSeconds);
  time.setMilliseconds(0);
  return time;
};


/**
 * Create Table Backup
 * @param {string} tableName
 * @return {Promise<DynamoDB.CreateBackupOutput>}
 */
const createBackup = async (tableName) => {
  const params = {
    BackupName: `Scheduled_${Date.now()}`,
    TableName: tableName,
  };
  return dynamo.createBackup(params).promise();
};


/**
 * Get Recent Valid Backups Count
 * @param {string} tableName
 * @return {Promise<number>}
 */
const getRecentBackupCount = async (tableName) => {
  const params = {
    TableName: tableName,
    TimeRangeLowerBound: getOutdatedBoundary(),
    TimeRangeUpperBound: new Date(),
  };
  const recentBackups = await dynamo.listBackups(params).promise();
  return recentBackups.BackupSummaries.length;
};


/**
 * List Outdated Backups
 * @param {string} tableName
 * @param {string} exclusiveStartBackupArn?
 * @return {Promise<DynamoDB.ListBackupsOutput>}
 */
const listOutdatedBackups = async (tableName, exclusiveStartBackupArn = '') => {
  const params = {
    TableName: tableName,
    TimeRangeUpperBound: getOutdatedBoundary(),
  };

  if (exclusiveStartBackupArn !== '') Object.assign(params, exclusiveStartBackupArn);

  return dynamo.listBackups(params).promise();
};

/**
 * Delete Outdated Backups
 * @param {DynamoDB.ListBackupsOutput} backups
 * @return {Promise<void>}
 */
const deleteOutdatedBackups = async (backups) => {
  await Promise.all(backups.BackupSummaries.map(async (backupSummary) => {
    const arn = backupSummary.BackupArn;
    const params = {BackupArn: arn};
    console.log(`[${backupSummary.TableName}] backup deleted: ${arn}`);
    return dynamo.deleteBackup(params).promise();
  }));
};

/**
 * Handler
 * @param event
 * @param {Context} context
 * @param {Callback} callback
 * @return {Promise<void>}
 */
export const dynamodbOnDemandBackup = async (event, context, callback) => {
  console.log(`[${new Date().toLocaleString('ja-JP')}] BACKUP START`);
  try {
    await Promise.all(BACKUP_TABLES.map(async (tableName) => {
      // 1. create new backup
      const newBackup = await createBackup(tableName);
      console.log(`[${tableName}] backup created: ${newBackup.BackupDetails.BackupArn}`);

      const outdatedBackups = await listOutdatedBackups(tableName);
      const outdatedBackupCount = outdatedBackups.BackupSummaries.length;
      const recentBackupCount = await getRecentBackupCount(tableName);

      console.log(`[${tableName}] backup outdated boundary: ${getOutdatedBoundary().toLocaleString('ja-JP')}`);
      console.log(`[${tableName}] outdated backup count: ${outdatedBackupCount}`);
      console.log(`[${tableName}] recent backup count: ${recentBackupCount}`);

      // 2. flag if there's more than one page in outdatedBackups
      let lastEvaluatedBackupArn = outdatedBackups.LastEvaluatedBackupArn;

      // stop if no outdated backups or recent backups counts is less than minimum counts
      if (outdatedBackupCount < 1 || (!lastEvaluatedBackupArn && recentBackupCount < BACKUP_MIN_COUNT)) return;

      // 3. delete outdated backups listed in first page
      await deleteOutdatedBackups(outdatedBackups);

      // 4. delete outdated backups listed in the following pages
      while (lastEvaluatedBackupArn !== undefined) {
        const nextOutdatedBackups = await listOutdatedBackups(tableName, lastEvaluatedBackupArn);
        lastEvaluatedBackupArn = nextOutdatedBackups.LastEvaluatedBackupArn;
        await deleteOutdatedBackups(nextOutdatedBackups);
      }
    }));

    callback(null, `[${new Date().toLocaleString('ja-JP')}] BACKUP DONE`);
  } catch (error) {
    callback(error, 'ERROR');
  }
};

