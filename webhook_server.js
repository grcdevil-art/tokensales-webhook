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

// PostgreSQL 连接池
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render 需要 SSL
});

// 初始化数据库表
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        api_key VARCHAR(100) UNIQUE NOT NULL,
        balance INTEGER DEFAULT 1000, -- 美分，$10
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        source VARCHAR(100) DEFAULT 'formspark',
        metadata JSONB DEFAULT '{}'
      );
    `);
    console.log('✅ 数据库表初始化成功');
  } catch (err) {
    console.error('❌ 数据库初始化失败:', err);
  } finally {
    client.release();
  }
}
initDB();

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 生成随机 API Key
function generateApiKey() {
  return 'tks_' + crypto.randomBytes(16).toString('hex');
}

// 记录新用户到本地文件（方便手动查看）
function logNewUser(email, apiKey) {
  const logPath = path.join(dataDir, 'new_users_today.txt');
  const line = `${new Date().toISOString()} | ${email} | ${apiKey}\n`;
  fs.appendFileSync(logPath, line);
}

// Webhook 接收端点
app.post('/webhook/formspark', async (req, res) => {
  console.log('📩 收到 Webhook 请求');
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

// 可选：查看用户列表（仅用于测试，生产应加认证）
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, api_key, balance, created_at FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Webhook server running on port ${PORT}`);
});
