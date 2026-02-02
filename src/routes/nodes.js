/**
 * API for managing Hysteria nodes
 */

const express = require('express');
const router = express.Router();
const HyNode = require('../models/hyNodeModel');
const HyUser = require('../models/hyUserModel');
const ServerGroup = require('../models/serverGroupModel');
const cryptoService = require('../services/cryptoService');
const cache = require('../services/cacheService');
const logger = require('../utils/logger');

/**
 * Invalidate cache when nodes change
 */
async function invalidateNodesCache() {
    await cache.invalidateNodes();
    await cache.invalidateAllSubscriptions();
    await cache.invalidateDashboardCounts();
}

/**
 * GET /nodes - List all nodes
 */
router.get('/', async (req, res) => {
    try {
        const { active, group, status } = req.query;
        
        const filter = {};
        if (active !== undefined) filter.active = active === 'true';
        if (group) filter.groups = group;
        if (status) filter.status = status;
        
        const nodes = await HyNode.find(filter)
            .populate('groups', 'name color')
            .sort({ name: 1 });
        
        res.json(nodes);
    } catch (error) {
        logger.error(`[Nodes API] List error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/:id - Get a node
 */
router.get('/:id', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id).populate('groups', 'name color');
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        // Count users on this node
        const userCount = await HyUser.countDocuments({
            nodes: node._id,
            enabled: true
        });
        
        res.json({
            ...node.toObject(),
            userCount,
        });
    } catch (error) {
        logger.error(`[Nodes API] Get node error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes - Create a node
 */
router.post('/', async (req, res) => {
    try {
        const {
            name, ip, domain, sni, port, portRange, statsPort,
            groups, ssh, paths, settings, rankingCoefficient
        } = req.body;
        
        if (!name || !ip) {
            return res.status(400).json({ error: 'name и ip обязательны' });
        }
        
        // Check IP uniqueness
        const existing = await HyNode.findOne({ ip });
        if (existing) {
            return res.status(409).json({ error: 'Нода с таким IP уже существует' });
        }
        
        // Generate a secret for the stats API
        const statsSecret = cryptoService.generateNodeSecret();
        
        const node = new HyNode({
            name,
            ip,
            domain: domain || '',
            sni: sni || '',
            port: port || 443,
            portRange: portRange || '20000-50000',
            statsPort: statsPort || 9999,
            statsSecret,
            groups: groups || [],
            ssh: ssh || {},
            paths: paths || {},
            settings: settings || {},
            rankingCoefficient: rankingCoefficient || 1.0,
            active: true,
            status: 'offline',
        });
        
        await node.save();
        
        // Invalidate cache
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Created node ${name} (${ip})`);
        
        res.status(201).json(node);
    } catch (error) {
        logger.error(`[Nodes API] Create node error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /nodes/:id - Update a node
 */
router.put('/:id', async (req, res) => {
    try {
        const allowedUpdates = [
            'name', 'domain', 'sni', 'port', 'portRange', 'statsPort',
            'groups', 'ssh', 'paths', 'settings', 'active', 'rankingCoefficient'
        ];
        
        const updates = {};
        for (const key of allowedUpdates) {
            if (req.body[key] !== undefined) {
                updates[key] = req.body[key];
            }
        }
        
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { new: true }
        ).populate('groups', 'name color');
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        // Invalidate cache
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Updated node ${node.name}`);
        
        res.json(node);
    } catch (error) {
        logger.error(`[Nodes API] Update error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /nodes/:id - Delete a node
 */
router.delete('/:id', async (req, res) => {
    try {
        const node = await HyNode.findByIdAndDelete(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        // Remove the node from users
        await HyUser.updateMany(
            { nodes: node._id },
            { $pull: { nodes: node._id } }
        );
        
        // Invalidate cache
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Deleted node ${node.name}`);
        
        res.json({ success: true, message: 'Нода удалена' });
    } catch (error) {
        logger.error(`[Nodes API] Delete error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/:id/status - Get node status
 */
router.get('/:id/status', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id).select('name status lastError onlineUsers lastSync');
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        res.json({
            name: node.name,
            status: node.status,
            lastError: node.lastError,
            onlineUsers: node.onlineUsers,
            lastSync: node.lastSync,
        });
    } catch (error) {
        logger.error(`[Nodes API] Get status error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/reset-status - Reset node status to online
 */
router.post('/:id/reset-status', async (req, res) => {
    try {
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $set: { status: 'online', lastError: '' } },
            { new: true }
        );
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        logger.info(`[Nodes API] Node ${node.name} status reset to online`);
        
        res.json({ success: true, message: 'Статус сброшен', node });
    } catch (error) {
        logger.error(`[Nodes API] Status reset error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/sync - Force node synchronization
 */
router.post('/:id/sync', async (req, res) => {
    try {
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $set: { status: 'syncing' } },
            { new: true }
        );
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        logger.info(`[Nodes API] Started sync for node ${node.name}`);
        
        res.json({ success: true, message: 'Синхронизация запущена' });
    } catch (error) {
        logger.error(`[Nodes API] Start sync error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/:id/users - Users on the node
 */
router.get('/:id/users', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        const users = await HyUser.find({
            nodes: node._id,
            enabled: true
        }).select('userId username traffic');
        
        res.json(users);
    } catch (error) {
        logger.error(`[Nodes API] Get users error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/groups - Add node to groups
 */
router.post('/:id/groups', async (req, res) => {
    try {
        const { groups } = req.body;
        
        if (!Array.isArray(groups)) {
            return res.status(400).json({ error: 'groups должен быть массивом' });
        }
        
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $addToSet: { groups: { $each: groups } } },
            { new: true }
        ).populate('groups', 'name color');
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        // Invalidate cache
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Added groups for node ${node.name}`);
        res.json(node);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /nodes/:id/groups/:groupId - Remove node from a group
 */
router.delete('/:id/groups/:groupId', async (req, res) => {
    try {
        const node = await HyNode.findByIdAndUpdate(
            req.params.id,
            { $pull: { groups: req.params.groupId } },
            { new: true }
        ).populate('groups', 'name color');
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        // Invalidate cache
        await invalidateNodesCache();
        
        logger.info(`[Nodes API] Removed group ${req.params.groupId} from node ${node.name}`);
        res.json(node);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /nodes/:id/config - Get the node's current config
 */
router.get('/:id/config', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        // Generate config with HTTP auth
        const configGenerator = require('../services/configGenerator');
        const config = require('../../config');
        
        const baseUrl = process.env.BASE_URL || `http://localhost:${config.PORT}`;
        const authUrl = `${baseUrl}/api/auth`;
        
        const configContent = configGenerator.generateNodeConfig(node, authUrl);
        
        res.type('text/yaml').send(configContent);
    } catch (error) {
        logger.error(`[Nodes API] Config generation error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/setup-port-hopping - Configure port hopping on a node
 */
router.post('/:id/setup-port-hopping', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        const syncService = require('../services/syncService');
        const success = await syncService.setupPortHopping(node);
        
        if (success) {
            res.json({ success: true, message: 'Port hopping настроен' });
        } else {
            res.status(500).json({ error: 'Не удалось настроить port hopping' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /nodes/:id/update-config - Update node config via SSH
 */
router.post('/:id/update-config', async (req, res) => {
    try {
        const node = await HyNode.findById(req.params.id);
        
        if (!node) {
            return res.status(404).json({ error: 'Нода не найдена' });
        }
        
        const syncService = require('../services/syncService');
        const success = await syncService.updateNodeConfig(node);
        
        if (success) {
            res.json({ success: true, message: 'Конфиг обновлён' });
        } else {
            res.status(500).json({ error: 'Не удалось обновить конфиг' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
