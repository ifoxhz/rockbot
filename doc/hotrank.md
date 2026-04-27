# 📘《热榜量化系统 V1 可直接开发版（Node.js + SQLite + Tushare）》设计文档

> 技术栈：Node.js + SQLite + Tushare
> 目标：快速落地一个本地运行的 A 股热榜量化分析系统。

---

# 一、系统目标

构建一个每天自动运行的软件，实现：

```text id="h1r1p9"
1. 拉取东方财富热榜（通过 Tushare）
2. 存储热榜历史快照
3. 计算热度变化趋势
4. 发现低位升温股
5. 识别高位过热股
6. 输出观察池
```

---

# 二、推荐技术栈

| 模块       | 技术          |
| -------- | ----------- |
| 运行环境     | Node.js 20+ |
| Web框架    | Express     |
| 定时任务     | node-cron   |
| 数据库      | SQLite      |
| ORM（可选）  | Drizzle ORM |
| 图表前端（后续） | ECharts     |

---

# 三、系统架构

```text id="lqk8m7"
┌─────────────────────┐
│   Tushare API       │
└─────────┬───────────┘
          ↓
┌─────────────────────┐
│   Collector         │ 定时采集
└─────────┬───────────┘
          ↓
┌─────────────────────┐
│   SQLite Database   │
└─────────┬───────────┘
          ↓
 ┌────────┴────────┐
 ↓                 ↓
Feature Engine     Strategy Engine
热度计算            选股逻辑

          ↓
 REST API / Dashboard
```

---

# 四、项目目录结构（可直接开发）

```text id="k9vw9o"
hot-rank-system/

├── package.json
├── .env
├── src/
│   ├── app.js
│   ├── config.js
│   ├── db.js
│   ├── scheduler.js
│   ├── services/hotrank
│   │    ├── collector.js
│   │    ├── feature.js
│   │    └── strategy.js
│   ├── routes/
│   │    ├── rank.js
│   │    └── signal.js
│   └── utils/
│        └── date.js
│
└── data/hotrank.db
```

---

# 五、数据库设计（SQLite）

---

# 1️⃣ 热榜快照表（核心）

```sql
CREATE TABLE hot_rank_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date TEXT,
  capture_time TEXT,
  stock_code TEXT,
  stock_name TEXT,
  rank_no INTEGER,
  rank_type TEXT,
  score REAL,
  price REAL,
  pct_chg REAL
);
```

---

# 2️⃣ 特征表

```sql
CREATE TABLE hot_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_code TEXT,
  calc_time TEXT,
  rank_now INTEGER,
  rank_prev INTEGER,
  heat_speed REAL,
  appear_7d INTEGER,
  top10_30d INTEGER
);
```

---

# 3️⃣ 策略信号表

```sql
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_time TEXT,
  ts_code TEXT,
  stock_name TEXT,
  signal_type TEXT,
  score REAL,
  reason TEXT
);
```

---

# 六、环境变量

```bash
TUSHARE_TOKEN=你的token
DB_PATH=./data/hotrank.db
```

---

# 七、核心模块设计

---

# 模块1：Tushare API 客户端

```js
src/services/hotrank/tushare.js
```

职责：

```text id="rkk41k"
封装 Tushare 请求
统一返回 JSON
异常重试
```

接口：

```js
getHotRank()
getRiseRank()
```

---

# 模块2：采集器

```js
src/services/hotrank/collector.js
```

流程：

```text id="g0j0gp"
拉取榜单
→ 写入 hot_rank_snapshot
→ 去重
→ 输出日志
```

---

# 模块3：特征计算

```js
src/services/hotrank/feature.js
```

---

## 热度速度（重点）

```text id="wjlwmv"
7-day linear slope

---

## 出现频率

```text id="i4i29l"
过去7天出现次数
```

---

## 榜单稳定度

```text id="r24n2n"
过去30天 Top10 次数
```

---

# 模块4：策略引擎

```js
src/services/strategy.js
```

---

# 策略A：低位升温股

```text id="fj6n8u"
1. 今日进入前30
2. 连续3次排名提升
3. 最近20日未大涨
```

输出：

```text id="rqfqyd"
BUY_WATCH
```

---


---

# 八、定时任务

```js
src/scheduler.js
```

使用 node-cron

---

## 交易时段抓取

```text id="md0vq6"

13:30
16:00
```

---

## 每次执行：

```text id="s1c9k4"
采集榜单
更新特征
运行策略
```

---

# 九、REST API 设计

---

## 获取今日热榜

```http
GET /api/rank/today
```

---

## 个股热度历史

```http
GET /api/rank/history/000001.SZ
```

---

## 今日信号池

```http
GET /api/signals
```

---

## 低位升温股

```http
GET /api/signals/buy
```

---

# 十、Node.js 示例代码结构

---

## db.js

```js
const Database = require('better-sqlite3');
const db = new Database('./data/hotrank.db');
module.exports = db;
```

---

## tushare.js

```js
const axios = require('axios');

async function getHotRank() {
   return axios.post('http://api.tushare.pro', {
      api_name: 'dc_hot',
      token: process.env.TUSHARE_TOKEN,
      params: { market: 'A' }
   });
}
```

---

## collector.js

```js
async function collect() {
   const rows = await getHotRank();

   rows.forEach(row => {
      // insert sqlite
   });
}
```

---


## V2

接入：

* 东方财富资金流
---

## V3

机器学习：

```text id="x8xgdc"
预测未来3日上涨概率
```

---

# 十三、推荐启动方式

```bash
npm install
npm run init-db
npm run dev
```

---

# 十四、最终建议（直接落地）

你现在最优组合：

```text id="v4r1xv"
Node.js + SQLite + Tushare
```

原因：

✔ 快速开发
✔ 本地部署简单
✔ 成本低
✔ 可持续扩展

---

