const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// SiliconFlow API 配置
const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';

// 模型定价配置（美分/百万token）
// 注意：模型ID必须与 SiliconFlow 支持的格式完全匹配
const MODEL_PRICING = {
  'deepseek-ai/DeepSeek-V3': { input: 28, output: 42, name: 'DeepSeek V3' },
  'deepseek-ai/DeepSeek-R1': { input: 50, output: 150, name: 'DeepSeek R1' },
  'Pro/deepseek-ai/DeepSeek-V3': { input: 28, output: 42, name: 'DeepSeek V3 (Pro)' },
  'Pro/deepseek-ai/DeepSeek-R1': { input: 50, output: 150, name: 'DeepSeek R1 (Pro)' },
  'MiniMax/MiniMax-M2.5': { input: 30, output: 120, name: 'MiniMax M2.5' },
  'moonshot/kimi-k2.5': { input: 60, output: 300, name: 'Kimi K2.5' },
  'zhipai/glm-5': { input: 100, output: 320, name: 'GLM-5' }
};

// 确保数据目录存在
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
    console.log('⚠️ 服务将以无数据库模式运行');
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
      
      await client.query(`
        CREATE TABLE IF NOT EXISTS usage_log (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          model VARCHAR(100) NOT NULL,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          cost INTEGER DEFAULT 0,
          status VARCHAR(50) DEFAULT 'success',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

pool = initPool();
if (pool) {
  initDB();
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ Webhook 功能 ============

function generateApiKey() {
  return 'tks_' + crypto.randomBytes(16).toString('hex');
}

function logNewUser(email, apiKey) {
  const logPath = path.join(dataDir, 'new_users_today.txt');
  const line = `${new Date().toISOString()} | ${email} | ${apiKey}\n`;
  fs.appendFileSync(logPath, line);
}

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

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      console.log('⏭️ 邮箱已存在，跳过:', email);
      return res.status(200).json({ message: 'Email already registered' });
    }

    const apiKey = generateApiKey();
    await pool.query(
      'INSERT INTO users (email, api_key) VALUES ($1, $2)',
      [email, apiKey]
    );

    logNewUser(email, apiKey);
    console.log('✅ 新用户已保存:', email, apiKey);
    res.status(200).json({ success: true, email, apiKey });
  } catch (err) {
    console.error('❌ Webhook 处理错误:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============ API 代理功能 ============

async function validateApiKey(apiKey) {
  if (!pool) {
    return { valid: false, error: 'Database not available' };
  }
  
  try {
    const result = await pool.query(
      'SELECT id, email, balance, status FROM users WHERE api_key = $1 AND status = $2',
      [apiKey, 'active']
    );
    if (result.rows.length === 0) {
      return { valid: false, error: 'Invalid API key' };
    }
    const user = result.rows[0];
    if (user.balance <= 0) {
      return { valid: false, error: 'Insufficient balance' };
    }
    return { valid: true, user };
  } catch (err) {
    console.error('Database error:', err);
    return { valid: false, error: 'Database error' };
  }
}

async function deductBalance(userId, cost) {
  if (!pool) return;
  try {
    await pool.query(
      'UPDATE users SET balance = balance - $1 WHERE id = $2',
      [cost, userId]
    );
  } catch (err) {
    console.error('Failed to deduct balance:', err);
  }
}

async function logUsage(userId, model, inputTokens, outputTokens, cost, status) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO usage_log (user_id, model, input_tokens, output_tokens, cost, status, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [userId, model, inputTokens, outputTokens, cost, status]
    );
  } catch (err) {
    console.error('Failed to log usage:', err);
  }
}

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    time: new Date().toISOString(),
    dbConnected: dbConnected,
    port: PORT
  });
});

app.get('/v1/balance', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing API key' });
  }
  
  const apiKey = authHeader.slice(7);
  const validation = await validateApiKey(apiKey);
  
  if (!validation.valid) {
    return res.status(401).json({ error: validation.error });
  }
  
  res.json({ 
    balance: validation.user.balance,
    currency: 'USD cents',
    email: validation.user.email
  });
});

app.get('/v1/models', (req, res) => {
  const models = Object.entries(MODEL_PRICING).map(([id, pricing]) => ({
    id,
    name: pricing.name,
    pricing: {
      input: `$${(pricing.input / 100).toFixed(2)}/M tokens`,
      output: `$${(pricing.output / 100).toFixed(2)}/M tokens`
    }
  }));
  
  res.json({ object: 'list', data: models });
});

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

app.post('/v1/chat/completions', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: { message: 'Missing API key', type: 'authentication_error' }
    });
  }
  
  const apiKey = authHeader.slice(7);
  const validation = await validateApiKey(apiKey);
  
  if (!validation.valid) {
    return res.status(401).json({ 
      error: { message: validation.error, type: 'authentication_error' }
    });
  }
  
  const user = validation.user;
  const { model, messages, stream = false } = req.body;
  
  if (!MODEL_PRICING[model]) {
    return res.status(400).json({
      error: { message: `Model ${model} not supported`, type: 'invalid_request_error' }
    });
  }
  
  const inputText = messages.map(m => m.content).join('');
  const estimatedInputTokens = Math.ceil(inputText.length / 4);
  
  try {
    const response = await fetch(`${SILICONFLOW_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SILICONFLOW_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        stream,
        max_tokens: 4096
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      await logUsage(user.id, model, estimatedInputTokens, 0, 0, 'upstream_error');
      return res.status(response.status).json({
        error: { message: 'Upstream API error', details: error }
      });
    }
    
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let outputText = '';
      
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = new TextDecoder().decode(value);
        res.write(chunk);
        
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta?.content) {
                outputText += data.choices[0].delta.content;
              }
            } catch (e) {}
          }
        }
      }
      
      res.end();
      
      const outputTokens = Math.ceil(outputText.length / 4);
      const pricing = MODEL_PRICING[model];
      const cost = Math.ceil(
        (estimatedInputTokens * pricing.input + outputTokens * pricing.output) / 1000000
      );
      
      await deductBalance(user.id, cost);
      await logUsage(user.id, model, estimatedInputTokens, outputTokens, cost, 'success');
      
    } else {
      const data = await response.json();
      
      const outputTokens = data.usage?.completion_tokens || Math.ceil(
        (data.choices?.[0]?.message?.content || '').length / 4
      );
      const inputTokens = data.usage?.prompt_tokens || estimatedInputTokens;
      
      const pricing = MODEL_PRICING[model];
      const cost = Math.ceil(
        (inputTokens * pricing.input + outputTokens * pricing.output) / 1000000
      );
      
      if (user.balance < cost) {
        await logUsage(user.id, model, inputTokens, outputTokens, 0, 'insufficient_balance');
        return res.status(402).json({
          error: { 
            message: `Insufficient balance. Required: ${cost} cents, Available: ${user.balance} cents`,
            type: 'insufficient_balance'
          }
        });
      }
      
      await deductBalance(user.id, cost);
      await logUsage(user.id, model, inputTokens, outputTokens, cost, 'success');
      
      data.balance_remaining = user.balance - cost;
      
      res.json(data);
    }
    
  } catch (err) {
    console.error('Proxy error:', err);
    await logUsage(user.id, model, estimatedInputTokens, 0, 0, 'error');
    res.status(500).json({
      error: { message: 'Internal server error', type: 'server_error' }
    });
  }
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'TokenSales API Server',
    version: '2.0.0',
    endpoints: {
      health: '/health',
      webhook: '/webhook/formspark',
      balance: '/v1/balance',
      models: '/v1/models',
      chat: '/v1/chat/completions',
      users: '/api/users'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 TokenSales Server running on port ${PORT}`);
  console.log(`📊 数据库状态: ${dbConnected ? '已连接' : '未连接'}`);
  console.log(`🤖 支持的模型: ${Object.keys(MODEL_PRICING).length}`);
});