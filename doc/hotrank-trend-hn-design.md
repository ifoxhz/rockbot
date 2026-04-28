# Hotrank 趋势评分（HN 改进版）设计文档

## 1. 背景与目标

当前 `hotrank` 的趋势排序从线性加权（`trend_5/trend_10/trend_25`）演进为更适合“热度持续上升”识别的 HN 改进算法。

目标：

- 在 25 天窗口中识别“持续改善”的股票，而不是只奖励单日突发。
- 保留 Hacker News 的核心思想（热度信号 + 时间衰减）。
- 输出可解释指标，便于调参和复盘。

---

## 2. 设计原则

- **持续性优先**：累计多日改善优于单日暴涨。
- **近期性保留**：同等持续性下，近期还在改善的优先。
- **复杂度可控**：尽量少因子，仅保留必要惩罚项。
- **可解释性**：每个候选都输出 `persist_gain/age/max_jump/penalty`。

---

## 3. 核心评分公式

设 `rank_t` 为第 `t` 天的人气排名（越小越热）。

### 3.1 日改善量

```text
improve_t = max(0, rank_{t-1} - rank_t)
```

只累计“排名变小”的正向改善，不把恶化（排名变大）计入热度。

### 3.2 持续改善热度（带时间权重）

```text
persist_gain = Σ [ improve_t * exp(-daysAgo_t / τ) ]
```

- `daysAgo_t`：该改善距离当前的天数
- `τ`：时间平滑常数（默认 `7`）

### 3.3 单日突刺惩罚

```text
max_jump = max(improve_t)
penalty  = λ * max_jump
adjusted_gain = max(0, persist_gain - penalty)
```

- `λ` 默认 `0.15`
- 目的是压制“单天极端冲榜”导致的虚高。

### 3.4 HN 改进总分

```text
score = (adjusted_gain ^ α) / ((age + 2) ^ γ)
```

- `age`：最近一次正向改善距今天数（越小越新）
- `α` 默认 `0.9`
- `γ` 默认 `1.35`

---

## 4. 参数默认值

- `α = 0.9`
- `γ = 1.35`
- `τ = 7`
- `λ = 0.15`

这些参数先以“稳健识别”为导向。若仍偏突刺，优先调大 `λ`；若太保守，调小 `γ`。

---

## 5. 数据口径与窗口

- 默认窗口：`25` 天（`window=25`）。
- 输入表：`hot_rank_snapshot`。
- 日期轴：`trade_date`（非 `capture_time`）。
- 同一股票同一天多条记录时，聚合为：
  - `rank_no = MIN(rank_no)`
  - `score = MAX(score)`

---

## 6. 计算流程

1. 取最近 `window` 个 `trade_date`。
2. 聚合得到每只股票的按天 `rank` 序列。
3. 过滤：
   - 有效点数至少 3；
   - 有效转移至少 3（可计算 HN score）。
4. 逐股计算：
   - `persist_gain`
   - `max_jump`
   - `penalty`
   - `age`
   - `hn_score`
5. 按 `hn_score` 降序排序，返回 TopN。

---

## 7. 输出字段（TopTrend）

每只股票输出：

- `hn_score`
- `hn_persist_gain`
- `hn_age`
- `hn_penalty`
- `hn_max_jump`
- `trend_5/trend_10/trend_25`（保留用于辅助观察）
- `first_rank/latest_rank/rank_change/avg_rank`

诊断字段：

- `candidate_stocks`
- `regressable_stocks`
- `complete_score_stocks`
- `ranked_stocks`
- `reason`

---

## 8. 与旧算法差异

旧算法：

```text
score = 0.5*trend_5 + 0.3*trend_10 + 0.2*trend_25
```

问题：

- 容易被局部斜率放大；
- 对“单日大跳升”敏感。

新算法：

- 以“正向改善累计”为主；
- 用 `age` 保留新鲜度；
- 用 `max_jump` 惩罚突刺。

---

## 9. 落地位置

- 评分实现：`src/services/hotrank/topTrend.js`
- Top10 页面与接口：`src/commands/showline-html-server.js`
- 一键命令：`rockbot hot rank-top --window 25 --limit 10 --source eastmoney --debug`

---

## 10. 验证建议

1. 先补齐数据：
   - `rockbot hot -s eastmoney --backfill-days 25 --backfill-top 100 --debug`
2. 计算 Top10：
   - `rockbot hot rank-top --window 25 --limit 10 --source eastmoney --debug`
3. 页面复核：
   - `http://127.0.0.1:7070/showline/hotrank/top-trend`
4. 对比重点：
   - `hn_score` 高但 `hn_max_jump` 也高的票，是否符合策略预期；
   - 是否减少“纯突刺票”进入前列。

