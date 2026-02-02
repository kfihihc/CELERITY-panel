/**
 * Backup Service - automatic MongoDB backups with optional S3 upload
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const config = require('../../config');
const logger = require('../utils/logger');

const execAsync = promisify(exec);

// Lazy-load S3 client (only when needed)
let s3Client = null;

function getS3Client(settings) {
    if (!s3Client && settings?.backup?.s3?.enabled) {
        try {
            const { S3Client } = require('@aws-sdk/client-s3');
            s3Client = new S3Client({
                region: settings.backup.s3.region || 'us-east-1',
                endpoint: settings.backup.s3.endpoint || undefined,
                credentials: {
                    accessKeyId: settings.backup.s3.accessKeyId,
                    secretAccessKey: settings.backup.s3.secretAccessKey,
                },
                forcePathStyle: !!settings.backup.s3.endpoint, // for MinIO and similar
            });
        } catch (err) {
            logger.error(`[Backup] Failed to initialize S3 client: ${err.message}`);
            return null;
        }
    }
    return s3Client;
}

/**
 * Create a MongoDB backup
 */
async function createBackup(settings) {
    const backupDir = path.join(__dirname, '../../backups');
    
    // Create the directory if it doesn't exist
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `hysteria-backup-${timestamp}`;
    const backupPath = path.join(backupDir, backupName);
    const archivePath = path.join(backupDir, `${backupName}.tar.gz`);
    
    try {
        // Get MongoDB URI
        const mongoUri = config.MONGO_URI;
        
        // Run mongodump
        logger.info(`[Backup] Starting backup: ${backupName}`);
        const dumpCmd = `mongodump --uri="${mongoUri}" --out="${backupPath}" --gzip`;
        await execAsync(dumpCmd);
        logger.info(`[Backup] Dump created: ${backupPath}`);
        
        // Create tar archive
        const tarCmd = `cd "${backupDir}" && tar -czf "${backupName}.tar.gz" "${backupName}" && rm -rf "${backupName}"`;
        await execAsync(tarCmd);
        logger.info(`[Backup] Archive created: ${archivePath}`);
        
        // Get file size
        const stats = fs.statSync(archivePath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        
        // Upload to S3 if configured
        if (settings?.backup?.s3?.enabled) {
            await uploadToS3(archivePath, `${backupName}.tar.gz`, settings);
        }
        
        // Rotate old backups
        const keepLast = settings?.backup?.keepLast || 7;
        await rotateBackups(backupDir, keepLast);
        
        // Update last backup time
        const Settings = require('../models/settingsModel');
        await Settings.update({ 'backup.lastBackup': new Date() });
        
        logger.info(`[Backup] Completed: ${backupName} (${sizeMB} MB)`);
        
        return {
            success: true,
            filename: `${backupName}.tar.gz`,
            path: archivePath,
            size: stats.size,
            sizeMB: parseFloat(sizeMB),
        };
        
    } catch (error) {
        logger.error(`[Backup] Error: ${error.message}`);
        
        // Cleanup on error
        try {
            if (fs.existsSync(backupPath)) {
                fs.rmSync(backupPath, { recursive: true });
            }
        } catch (e) {}
        
        throw error;
    }
}

/**
 * Upload a file to S3
 */
async function uploadToS3(filePath, fileName, settings) {
    const client = getS3Client(settings);
    if (!client) {
        logger.warn('[Backup] S3 client not available, skipping upload');
        return;
    }
    
    try {
        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        const fileStream = fs.createReadStream(filePath);
        const stats = fs.statSync(filePath);
        
        const bucket = settings.backup.s3.bucket;
        const prefix = settings.backup.s3.prefix || 'backups';
        const key = `${prefix}/${fileName}`;
        
        logger.info(`[Backup] Uploading to S3: ${bucket}/${key}`);
        
        await client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: fileStream,
            ContentLength: stats.size,
            ContentType: 'application/gzip',
        }));
        
        logger.info(`[Backup] Uploaded to S3: ${key}`);
        
        // Rotate in S3 if configured
        if (settings.backup.s3.keepLast) {
            await rotateS3Backups(settings);
        }
        
    } catch (error) {
        logger.error(`[Backup] S3 upload error: ${error.message}`);
        // Do not interrupt: local backup is still created
    }
}

/**
 * Rotate backups in S3
 */
async function rotateS3Backups(settings) {
    const client = getS3Client(settings);
    if (!client) return;
    
    try {
        const { ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
        
        const bucket = settings.backup.s3.bucket;
        const prefix = settings.backup.s3.prefix || 'backups';
        const keepLast = settings.backup.s3.keepLast || 7;
        
        // Get the list of objects
        const listResult = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${prefix}/hysteria-backup-`,
        }));
        
        if (!listResult.Contents || listResult.Contents.length <= keepLast) {
            return;
        }
        
        // Sort by date (oldest first)
        const sorted = listResult.Contents
            .filter(obj => obj.Key.endsWith('.tar.gz'))
            .sort((a, b) => a.LastModified - b.LastModified);
        
        // Delete extras
        const toDelete = sorted.slice(0, sorted.length - keepLast);
        
        for (const obj of toDelete) {
            await client.send(new DeleteObjectCommand({
                Bucket: bucket,
                Key: obj.Key,
            }));
            logger.info(`[Backup] Deleted from S3: ${obj.Key}`);
        }
        
    } catch (error) {
        logger.error(`[Backup] S3 rotation error: ${error.message}`);
    }
}

/**
 * Rotate local backups
 */
async function rotateBackups(backupDir, keepLast) {
    try {
        const files = fs.readdirSync(backupDir)
            .filter(f => f.startsWith('hysteria-backup-') && f.endsWith('.tar.gz'))
            .map(f => ({
                name: f,
                path: path.join(backupDir, f),
                mtime: fs.statSync(path.join(backupDir, f)).mtime,
            }))
            .sort((a, b) => a.mtime - b.mtime); // oldest first
        
        if (files.length <= keepLast) {
            return;
        }
        
        const toDelete = files.slice(0, files.length - keepLast);
        
        for (const file of toDelete) {
            fs.unlinkSync(file.path);
            logger.info(`[Backup] Rotated old backup: ${file.name}`);
        }
        
        logger.info(`[Backup] Rotation complete. Kept ${keepLast} backups, deleted ${toDelete.length}`);
        
    } catch (error) {
        logger.error(`[Backup] Rotation error: ${error.message}`);
    }
}

/**
 * Get the list of local backups
 */
function listBackups() {
    const backupDir = path.join(__dirname, '../../backups');
    
    if (!fs.existsSync(backupDir)) {
        return [];
    }
    
    return fs.readdirSync(backupDir)
        .filter(f => f.startsWith('hysteria-backup-') && f.endsWith('.tar.gz'))
        .map(f => {
            const filePath = path.join(backupDir, f);
            const stats = fs.statSync(filePath);
            return {
                name: f,
                path: filePath,
                size: stats.size,
                sizeMB: (stats.size / 1024 / 1024).toFixed(2),
                created: stats.mtime,
            };
        })
        .sort((a, b) => b.created - a.created); // newest first
}

/**
 * Check whether a backup is needed
 */
async function shouldRunBackup(settings) {
    if (!settings?.backup?.enabled) {
        return false;
    }
    
    const intervalHours = settings.backup.intervalHours || 24;
    const lastBackup = settings.backup.lastBackup;
    
    if (!lastBackup) {
        return true; // No backups have been made yet
    }
    
    const hoursSinceLastBackup = (Date.now() - new Date(lastBackup).getTime()) / (1000 * 60 * 60);
    
    return hoursSinceLastBackup >= intervalHours;
}

/**
 * Scheduled backup (called from cron)
 */
async function scheduledBackup() {
    try {
        const Settings = require('../models/settingsModel');
        const settings = await Settings.get();
        
        if (await shouldRunBackup(settings)) {
            logger.info('[Backup] Starting scheduled backup');
            await createBackup(settings);
        }
    } catch (error) {
        logger.error(`[Backup] Scheduled backup failed: ${error.message}`);
    }
}

/**
 * Test S3 connection
 */
async function testS3Connection(s3Config) {
    try {
        const { S3Client, ListBucketsCommand } = require('@aws-sdk/client-s3');
        
        const client = new S3Client({
            region: s3Config.region || 'us-east-1',
            endpoint: s3Config.endpoint || undefined,
            credentials: {
                accessKeyId: s3Config.accessKeyId,
                secretAccessKey: s3Config.secretAccessKey,
            },
            forcePathStyle: !!s3Config.endpoint,
        });
        
        // Check access to the bucket
        const { HeadBucketCommand } = require('@aws-sdk/client-s3');
        await client.send(new HeadBucketCommand({ Bucket: s3Config.bucket }));
        
        return { success: true };
        
    } catch (error) {
        return { 
            success: false, 
            error: error.message,
        };
    }
}

/**
 * Get the list of backups from S3
 */
async function listS3Backups(settings) {
    const client = getS3Client(settings);
    if (!client) {
        return [];
    }
    
    try {
        const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
        
        const bucket = settings.backup.s3.bucket;
        const prefix = settings.backup.s3.prefix || 'backups';
        
        const result = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${prefix}/hysteria-backup-`,
        }));
        
        if (!result.Contents) {
            return [];
        }
        
        return result.Contents
            .filter(obj => obj.Key.endsWith('.tar.gz'))
            .map(obj => ({
                name: obj.Key.split('/').pop(),
                key: obj.Key,
                size: obj.Size,
                sizeMB: (obj.Size / 1024 / 1024).toFixed(2),
                created: obj.LastModified,
                source: 's3',
            }))
            .sort((a, b) => b.created - a.created); // newest first
            
    } catch (error) {
        logger.error(`[Backup] List S3 backups error: ${error.message}`);
        return [];
    }
}

/**
 * Download a backup from S3 for restore
 */
async function downloadFromS3(settings, key) {
    const client = getS3Client(settings);
    if (!client) {
        throw new Error('S3 client not available');
    }
    
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { Readable } = require('stream');
    
    const bucket = settings.backup.s3.bucket;
    const fileName = key.split('/').pop();
    const localPath = path.join(__dirname, '../../backups', fileName);
    
    logger.info(`[Backup] Downloading from S3: ${key}`);
    
    const response = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    }));
    
    // Save to a temporary file
    const writeStream = fs.createWriteStream(localPath);
    
    await new Promise((resolve, reject) => {
        response.Body.pipe(writeStream);
        response.Body.on('error', reject);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });
    
    logger.info(`[Backup] Downloaded: ${localPath}`);
    
    return localPath;
}

/**
 * Restore from a backup (local or S3)
 */
async function restoreBackup(settings, source, identifier) {
    let archivePath;
    let tempDownload = false;
    
    // Get the file
    if (source === 's3') {
        archivePath = await downloadFromS3(settings, identifier);
        tempDownload = true;
    } else {
        archivePath = path.join(__dirname, '../../backups', identifier);
        if (!fs.existsSync(archivePath)) {
            throw new Error('Backup file not found');
        }
    }
    
    const extractDir = path.join('/tmp', `restore-${Date.now()}`);
    
    try {
        // Create extraction directory
        fs.mkdirSync(extractDir, { recursive: true });
        
        // Extract archive
        await execAsync(`tar -xzf "${archivePath}" -C "${extractDir}"`);
        logger.info(`[Restore] Archive extracted to ${extractDir}`);
        
        // Find the dump folder
        const findDumpPath = (dir) => {
            const items = fs.readdirSync(dir);
            if (items.includes('hysteria') && fs.statSync(path.join(dir, 'hysteria')).isDirectory()) {
                return dir;
            }
            if (items.length === 1 && fs.statSync(path.join(dir, items[0])).isDirectory()) {
                return findDumpPath(path.join(dir, items[0]));
            }
            return dir;
        };
        
        const dumpPath = findDumpPath(extractDir);
        const hysteriaDir = path.join(dumpPath, 'hysteria');
        
        if (!fs.existsSync(hysteriaDir)) {
            throw new Error('Invalid backup: hysteria database folder not found');
        }
        
        // Restore
        const mongoUri = config.MONGO_URI;
        const restoreCmd = `mongorestore --uri="${mongoUri}" --drop --gzip --db=hysteria "${hysteriaDir}"`;
        
        logger.info(`[Restore] Starting restore from ${source}: ${identifier}`);
        await execAsync(restoreCmd);
        logger.info(`[Restore] Database restored successfully`);
        
        // Cleanup
        await execAsync(`rm -rf "${extractDir}"`);
        
        // Delete downloaded file from S3 if it was temporary
        if (tempDownload) {
            // Keep the file; it's now a local backup
        }
        
        return { success: true };
        
    } catch (error) {
        // Cleanup on error
        try {
            await execAsync(`rm -rf "${extractDir}"`);
        } catch (e) {}
        
        throw error;
    }
}

module.exports = {
    createBackup,
    listBackups,
    listS3Backups,
    downloadFromS3,
    restoreBackup,
    shouldRunBackup,
    scheduledBackup,
    testS3Connection,
    rotateBackups,
};
