const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// 上游 API 配置
const UPSTREAM_PROVIDER = process.env.UPSTREAM_PROVIDER || 'openrouter';
const UPSTREAM_BASE_URL = UPSTREAM_PROVIDER === 'openrouter' 
  ? 'https://openrouter.ai/api/v1'
  : 'https://api.siliconflow.cn/v1';

// OpenRouter 站点信息（必需）
const HTTP_REFERER = process.env.HTTP_REFERER || 'https://tokensales.onrender.com';
const X_TITLE = process.env.X_TITLE || 'TokenSales API';

// 模型售价配置（美分/百万输出token）
const MODEL_PRICING = {
  // OpenRouter 模型映射
  'deepseek/deepseek-chat': { 
    input: 50, 
    output: parseInt(process.env.DEEPSEEK_V3_PRICE) || 150, 
    name: 'DeepSeek V3',
    upstream_model: 'deepseek/deepseek-chat'
  },
  'deepseek/deepseek-r1': { 
    input: 55, 
    output: parseInt(process.env.DEEPSEEK_R1_PRICE) || 250, 
    name: 'DeepSeek R1',
    upstream_model: 'deepseek/deepseek-r1'
  },
  'minimax/minimax-m1': { 
    input: 100, 
    output: parseInt(process.env.MINIMAX_M2_5_PRICE) || 300, 
    name: 'MiniMax M2.5',
    upstream_model: 'minimax/minimax-m1'
  },
  'moonshotai/kimi-k2.5': { 
    input: 150, 
    output: parseInt(process.env.KIMI_K2_5_PRICE) || 450, 
    name: 'Kimi K2.5',
    upstream_model: 'moonshotai/kimi-k2.5'
  },
  'z-ai/glm-5': { 
    input: 100, 
    output: parseInt(process.env.GLM_5_PRICE) || 320, 
    name: 'GLM-5',
    upstream_model: 'z-ai/glm-5'
  },
  // SiliconFlow 备选映射
  'deepseek-ai/DeepSeek-V3': { 
    input: 28, 
    output: 42, 
    name: 'DeepSeek V3 (SF)',
    upstream_model: 'deepseek-ai/DeepSeek-V3'
  },
  'deepseek-ai/DeepSeek-R1': { 
    input: 55, 
    output: 150, 
    name: 'DeepSeek R1 (SF)',
    upstream_model: 'deepseek-ai/DeepSeek-R1'
  }
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
      // 创建 users 表
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
      
      // 创建 usage_log 表（增加 price 和 upstream 字段）
      await client.query(`
        CREATE TABLE IF NOT EXISTS usage_log (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(id),
          model VARCHAR(100) NOT NULL,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          price INTEGER DEFAULT 0,
          cost INTEGER DEFAULT 0,
          status VARCHAR(50) DEFAULT 'success',
          upstream VARCHAR(50) DEFAULT 'openrouter',
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

// 初始化
pool = initPool();
if (pool) {
  initDB();
}

// 中间件
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

async function logUsage(userId, model, inputTokens, outputTokens, price, cost, status, upstream) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO usage_log (user_id, model, input_tokens, output_tokens, price, cost, status, upstream, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [userId, model, inputTokens, outputTokens, price, cost, status, upstream]
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
    upstream: UPSTREAM_PROVIDER,
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

// 聊天补全代理 - 按售价扣费
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
  
  const pricing = MODEL_PRICING[model];
  const upstreamModel = pricing.upstream_model;
  
  try {
    // 构建请求头
    const headers = {
      'Authorization': `Bearer ${UPSTREAM_PROVIDER === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.SILICONFLOW_API_KEY}`,
      'Content-Type': 'application/json'
    };
    
    // OpenRouter 需要额外的头
    if (UPSTREAM_PROVIDER === 'openrouter') {
      headers['HTTP-Referer'] = HTTP_REFERER;
      headers['X-Title'] = X_TITLE;
    }
    
    const response = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: upstreamModel,
        messages,
        stream,
        max_tokens: 4096
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      await logUsage(user.id, model, 0, 0, pricing.output, 0, 'upstream_error', UPSTREAM_PROVIDER);
      return res.status(response.status).json({
        error: { message: 'Upstream API error', details: error }
      });
    }
    
    // 处理流式响应
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
      
      // 按售价计算费用（基于 output_tokens）
      const outputTokens = Math.ceil(outputText.length / 4);
      const cost = Math.ceil((outputTokens * pricing.output) / 1000000);
      
      await deductBalance(user.id, cost);
      await logUsage(user.id, model, 0, outputTokens, pricing.output, cost, 'success', UPSTREAM_PROVIDER);
      
    } else {
      // 非流式响应
      const data = await response.json();
      
      const outputTokens = data.usage?.completion_tokens || Math.ceil(
        (data.choices?.[0]?.message?.content || '').length / 4
      );
      const inputTokens = data.usage?.prompt_tokens || 0;
      
      // 按售价计算费用（基于 output_tokens）
      const cost = Math.ceil((outputTokens * pricing.output) / 1000000);
      
      // 检查余额是否足够
      if (user.balance < cost) {
        await logUsage(user.id, model, inputTokens, outputTokens, pricing.output, 0, 'insufficient_balance', UPSTREAM_PROVIDER);
        return res.status(402).json({
          error: { 
            message: `Insufficient balance. Required: ${cost} cents, Available: ${user.balance} cents`,
            type: 'insufficient_balance'
          }
        });
      }
      
      // 扣款并记录
      await deductBalance(user.id, cost);
      await logUsage(user.id, model, inputTokens, outputTokens, pricing.output, cost, 'success', UPSTREAM_PROVIDER);
      
      // 添加余额信息到响应
      data.balance_remaining = user.balance - cost;
      
      res.json(data);
    }
    
  } catch (err) {
    console.error('Proxy error:', err);
    await logUsage(user.id, model, 0, 0, pricing.output, 0, 'error', UPSTREAM_PROVIDER);
    res.status(500).json({
      error: { message: 'Internal server error', type: 'server_error' }
    });
  }
});

app.get('/', (req, res) => {
  res.json({ 
    message: 'TokenSales API Server',
    version: '2.1.0',
    upstream: UPSTREAM_PROVIDER,
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
  console.log(`🔗 上游提供商: ${UPSTREAM_PROVIDER}`);
  console.log(`🤖 支持的模型: ${Object.keys(MODEL_PRICING).length}`);
});
