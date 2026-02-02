/**
 * Hysteria Panel load test
 * 
 * Run: node scripts/benchmark.js <BASE_URL> [AUTH_TOKEN] [SUB_TOKEN]
 * Example: node scripts/benchmark.js https://panel.example.com
 * 
 * Tests:
 * - /health - basic health check
 * - /api/auth - authentication (critical endpoint)
 * - /api/files/:token - subscriptions
 */

const http = require('http');
const https = require('https');

// Test configuration
const CONFIG = {
    // Number of requests per endpoint
    requestsPerEndpoint: 500,
    
    // Concurrent requests at a time
    concurrency: 50,
    
    // Request timeout (ms)
    timeout: 10000,
};

// Console colors
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
};

function log(color, ...args) {
    console.log(color, ...args, colors.reset);
}

/**
 * Perform an HTTP request and measure time
 */
function makeRequest(url, options = {}) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const urlObj = new URL(url);
        const client = urlObj.protocol === 'https:' ? https : http;
        
        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            timeout: CONFIG.timeout,
            rejectUnauthorized: false, // For self-signed certificates
        };
        
        const req = client.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    success: res.statusCode >= 200 && res.statusCode < 400,
                    statusCode: res.statusCode,
                    time: Date.now() - startTime,
                    size: data.length,
                });
            });
        });
        
        req.on('error', (err) => {
            resolve({
                success: false,
                error: err.message,
                time: Date.now() - startTime,
            });
        });
        
        req.on('timeout', () => {
            req.destroy();
            resolve({
                success: false,
                error: 'Timeout',
                time: CONFIG.timeout,
            });
        });
        
        if (options.body) {
            req.write(JSON.stringify(options.body));
        }
        
        req.end();
    });
}

/**
 * Run a test with parallel requests
 */
async function runTest(name, url, options = {}) {
    log(colors.cyan, `\n📊 Тестирование: ${name}`);
    log(colors.reset, `   URL: ${url}`);
    log(colors.reset, `   Запросов: ${CONFIG.requestsPerEndpoint}, Параллельно: ${CONFIG.concurrency}`);
    
    const results = [];
    const startTime = Date.now();
    
    // Run requests in batches based on concurrency
    for (let i = 0; i < CONFIG.requestsPerEndpoint; i += CONFIG.concurrency) {
        const batch = [];
        const batchSize = Math.min(CONFIG.concurrency, CONFIG.requestsPerEndpoint - i);
        
        for (let j = 0; j < batchSize; j++) {
            batch.push(makeRequest(url, options));
        }
        
        const batchResults = await Promise.all(batch);
        results.push(...batchResults);
        
        // Progress
        process.stdout.write(`\r   Прогресс: ${results.length}/${CONFIG.requestsPerEndpoint}`);
    }
    
    const totalTime = Date.now() - startTime;
    console.log(); // New line after progress
    
    // Analyze results
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    const times = successful.map(r => r.time).sort((a, b) => a - b);
    
    if (times.length === 0) {
        log(colors.red, `   ❌ Все запросы неуспешны!`);
        if (failed.length > 0) {
            log(colors.red, `   Ошибки: ${failed.slice(0, 3).map(f => f.error || f.statusCode).join(', ')}`);
        }
        return null;
    }
    
    const stats = {
        name,
        total: results.length,
        successful: successful.length,
        failed: failed.length,
        successRate: (successful.length / results.length * 100).toFixed(1),
        rps: (results.length / (totalTime / 1000)).toFixed(1),
        min: times[0],
        max: times[times.length - 1],
        avg: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
        p50: times[Math.floor(times.length * 0.5)],
        p95: times[Math.floor(times.length * 0.95)],
        p99: times[Math.floor(times.length * 0.99)],
    };
    
    // Output results
    const successColor = stats.successRate >= 99 ? colors.green : stats.successRate >= 90 ? colors.yellow : colors.red;
    log(successColor, `   ✅ Успешно: ${stats.successful}/${stats.total} (${stats.successRate}%)`);
    log(colors.magenta, `   ⚡ RPS: ${stats.rps} запросов/сек`);
    log(colors.reset, `   ⏱️  Время ответа:`);
    log(colors.reset, `      Min: ${stats.min}ms | Avg: ${stats.avg}ms | Max: ${stats.max}ms`);
    log(colors.reset, `      P50: ${stats.p50}ms | P95: ${stats.p95}ms | P99: ${stats.p99}ms`);
    
    if (failed.length > 0) {
        log(colors.yellow, `   ⚠️  Ошибки: ${failed.slice(0, 3).map(f => f.error || `HTTP ${f.statusCode}`).join(', ')}`);
    }
    
    return stats;
}

/**
 * Main function
 */
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length < 1) {
        console.log(`
Usage: node scripts/benchmark.js <BASE_URL> [SUB_TOKEN]

Examples:
  node scripts/benchmark.js https://panel.example.com
  node scripts/benchmark.js https://panel.example.com abc123def456

Parameters:
  BASE_URL   - Panel URL (required)
  SUB_TOKEN  - Subscription token for /api/files/:token test (optional)

Tests:
  1. /health           - Health check (always)
  2. /api/auth         - Authentication with a test user
  3. /api/files/:token - Subscription (if SUB_TOKEN is provided)
`);
        process.exit(1);
    }
    
    const baseUrl = args[0].replace(/\/$/, '');
    const subToken = args[1];
    
    log(colors.bright, '\n🚀 Hysteria Panel - Нагрузочный тест');
    log(colors.reset, `   Сервер: ${baseUrl}`);
    log(colors.reset, `   Запросов на эндпоинт: ${CONFIG.requestsPerEndpoint}`);
    log(colors.reset, `   Параллельность: ${CONFIG.concurrency}`);
    
    const allStats = [];
    
    // Test 1: Health check
    const healthStats = await runTest(
        'Health Check',
        `${baseUrl}/health`
    );
    if (healthStats) allStats.push(healthStats);
    
    // Test 2: Auth (with a real user)
    const authStats = await runTest(
        'Auth (POST /api/auth)',
        `${baseUrl}/api/auth`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { addr: '127.0.0.1:12345', auth: '8322513720:4dd1683439f4a091dcde7f3b' },
        }
    );
    if (authStats) allStats.push(authStats);
    
    // Test 3: Subscription (if a token is provided)
    if (subToken) {
        const subStats = await runTest(
            'Subscription (GET /api/files/:token)',
            `${baseUrl}/api/files/${subToken}`,
            {
                headers: { 'User-Agent': 'Clash/1.0' },
            }
        );
        if (subStats) allStats.push(subStats);
    } else {
        log(colors.yellow, '\n⚠️  Тест подписок пропущен (не указан SUB_TOKEN)');
    }
    
    // Summary table
    if (allStats.length > 0) {
        log(colors.bright, '\n📋 ИТОГОВАЯ ТАБЛИЦА:');
        console.log('');
        console.log('┌─────────────────────────────────┬─────────┬─────────┬─────────┬─────────┬─────────┐');
        console.log('│ Эндпоинт                        │   RPS   │   Avg   │   P50   │   P95   │   P99   │');
        console.log('├─────────────────────────────────┼─────────┼─────────┼─────────┼─────────┼─────────┤');
        
        for (const stat of allStats) {
            const name = stat.name.padEnd(31);
            const rps = (stat.rps + '/s').padStart(7);
            const avg = (stat.avg + 'ms').padStart(7);
            const p50 = (stat.p50 + 'ms').padStart(7);
            const p95 = (stat.p95 + 'ms').padStart(7);
            const p99 = (stat.p99 + 'ms').padStart(7);
            console.log(`│ ${name} │ ${rps} │ ${avg} │ ${p50} │ ${p95} │ ${p99} │`);
        }
        
        console.log('└─────────────────────────────────┴─────────┴─────────┴─────────┴─────────┴─────────┘');
        
        // Save results to a file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsFile = `benchmark-${timestamp}.json`;
        const fs = require('fs');
        fs.writeFileSync(
            `scripts/${resultsFile}`,
            JSON.stringify({
                timestamp: new Date().toISOString(),
                config: CONFIG,
                baseUrl,
                results: allStats,
            }, null, 2)
        );
        log(colors.green, `\n💾 Результаты сохранены в: scripts/${resultsFile}`);
    }
    
    log(colors.bright, '\n✅ Тестирование завершено!\n');
}

main().catch(err => {
    console.error('Ошибка:', err.message);
    process.exit(1);
});
