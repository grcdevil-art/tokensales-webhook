const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// 确保数据目录存在（用于记录新用户文件，不是主要存储）
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// 全局变量存储数据库连接状态
let pool = null;
let dbConnected = false;

// 初始化 PostgreSQL 连接池
function initPool() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ 错误: DATABASE_URL 环境变量未设置');
    console.log('⚠️ 服务将以无数据库模式运行（仅健康检查可用）');
    return null;
  }

  try {
    const newPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      max: 10
    });

    newPool.on('error', (err) => {
      console.error('❌ PostgreSQL 连接池错误:', err);
      dbConnected = false;
    });

    return newPool;
  } catch (err) {
    console.error('❌ 创建数据库连接池失败:', err);
    return null;
  }
}

// 初始化数据库表
async function initDB() {
  if (!pool) {
    console.log('⚠️ 数据库未配置，跳过表初始化');
    return;
  }

  try {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          api_key VARCHAR(100) UNIQUE NOT NULL,
          balance INTEGER DEFAULT 1000,
          status VARCHAR(20) DEFAULT 'active',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          source VARCHAR(100) DEFAULT 'formspark',
          metadata JSONB DEFAULT '{}'
        );
      `);
      console.log('✅ 数据库表初始化成功');
      dbConnected = true;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('❌ 数据库初始化失败:', err.message);
    dbConnected = false;
  }
}

// 初始化数据库连接
pool = initPool();
if (pool) {
  initDB();
}

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 生成随机 API Key
function generateApiKey() {
  return 'tks_' + crypto.randomBytes(16).toString('hex');
}

// 记录新用户到本地文件
function logNewUser(email, apiKey) {
  const logPath = path.join(dataDir, 'new_users_today.txt');
  const line = `${new Date().toISOString()} | ${email} | ${apiKey}\n`;
  fs.appendFileSync(logPath, line);
}

// 健康检查
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date().toISOString(),
    dbConnected: dbConnected,
    port: PORT
  });
});

// Webhook 接收端点
app.post('/webhook/formspark', async (req, res) => {
  console.log('📩 收到 Webhook 请求');
  
  if (!dbConnected || !pool) {
    return res.status(503).json({ 
      error: 'Database not available',
      message: '服务暂时无法处理请求，请稍后重试'
    });
  }

  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    // 检查邮箱是否已存在
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      console.log('⏭️ 邮箱已存在，跳过:', email);
      return res.status(200).json({ message: 'Email already registered' });
    }

    // 生成新 API Key
    const apiKey = generateApiKey();
    // 插入数据库
    await pool.query(
      'INSERT INTO users (email, api_key) VALUES ($1, $2)',
      [email, apiKey]
    );

    // 记录到本地文件
    logNewUser(email, apiKey);

    console.log('✅ 新用户已保存:', email, apiKey);
    res.status(200).json({ success: true, email, apiKey });
  } catch (err) {
    console.error('❌ Webhook 处理错误:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 查看用户列表
app.get('/api/users', async (req, res) => {
  if (!dbConnected || !pool) {
    return res.status(503).json({ error: 'Database not available' });
  }

  try {
    const result = await pool.query('SELECT id, email, api_key, balance, created_at FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 根路径
app.get('/', (req, res) => {
  res.json({ 
    message: 'TokenSales Webhook Server',
    health: '/health',
    webhook: '/webhook/formspark'
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 Webhook server running on port ${PORT}`);
  console.log(`📊 数据库状态: ${dbConnected ? '已连接' : '未连接'}`);
});
