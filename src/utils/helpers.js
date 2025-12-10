/**
 * Common helpers
 */

const Settings = require('../models/settingsModel');
const ServerGroup = require('../models/serverGroupModel');
const cache = require('../services/cacheService');

async function getSettings() {
    const cached = await cache.getSettings();
    if (cached) return cached;
    
    const settings = await Settings.get();
    await cache.setSettings(settings.toObject ? settings.toObject() : settings);
    
    return settings;
}

async function invalidateSettingsCache() {
    await cache.invalidateSettings();
}

async function getNodesByGroups(userGroups) {
    const HyNode = require('../models/hyNodeModel');
    
    if (!userGroups || userGroups.length === 0) {
        return HyNode.find({ 
            active: true,
            $or: [
                { groups: { $size: 0 } },
                { groups: { $exists: false } }
            ]
        });
    }
    
    return HyNode.find({
        active: true,
        $or: [
            { groups: { $in: userGroups } },
            { groups: { $size: 0 } },
            { groups: { $exists: false } }
        ]
    });
}

async function getActiveGroups() {
    const cached = await cache.getGroups();
    if (cached) return cached;
    
    const groups = await ServerGroup.find({ active: true }).sort({ name: 1 }).lean();
    await cache.setGroups(groups);
    
    return groups;
}

async function invalidateGroupsCache() {
    await cache.invalidateGroups();
}

module.exports = {
    getSettings,
    invalidateSettingsCache,
    getNodesByGroups,
    getActiveGroups,
    invalidateGroupsCache,
};
