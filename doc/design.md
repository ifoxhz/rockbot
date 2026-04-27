下面是整理好的 **Markdown 文件内容**（已经去掉多余引用格式，适合你直接保存为 `.md` 文件并交给 Codex 使用）👇

---

# 📘 资金行为驱动交易模型（算法设计文档）

---

## 1. 🎯 问题定义

构建一个基于**订单流结构（大单 vs 小单）**的交易模型，用于：

* 识别主力资金行为（吸筹 / 出货 / 洗盘）
* 过滤噪声与假信号
* 评估未来价格上涨概率
* 输出可执行交易决策（买 / 不买 / 仓位）

---

## 2. 🧠 核心假设（Alpha来源）

### 2.1 行为假设

```
主力资金（超大单）具有信息优势
散户资金（小单）具有滞后性
```

---

### 2.2 结构性信号

```
当出现：
超大单净流出 + 小单净流入

→ 市场出现资金分歧
→ 可能对应主力控盘行为
```

---

### 2.3 非对称性原则

```
同一资金结构在不同价格位置下含义不同：

低位 → 吸筹概率高
高位 → 出货概率高
```

---

## 3. 🧱 模型整体结构

```
输入数据
   ↓
因子计算（Feature Extraction）
   ↓
状态过滤（State Filtering）
   ↓
结构评分（Scoring System）
   ↓
触发机制（Trigger）
   ↓
决策输出（Decision）
   ↓
结果评估（Evaluation）
```

---

## 4. 📊 因子定义（Feature Space）

### 4.1 资金结构因子（核心）

设时间窗口 T（如25日）：

$$
F_{div} =
\begin{cases}
1, & \sum_{t=1}^{T} SuperLarge_t < 0 \ \text{and} \ \sum_{t=1}^{T} Small_t > 0 \
0, & \text{otherwise}
\end{cases}
$$

---

### 4.2 强度因子（Signal Strength）

$$
F_{strength} = \frac{\left| \sum_{t=1}^{T} SuperLarge_t \right|}{\sum_{t=1}^{T} Amount_t}
$$

---

### 4.3 价格位置因子（Position）

$$
F_{pos} = \frac{P_{current} - P_{low}}{P_{high} - P_{low}}
$$

---

### 4.4 趋势因子（Trend）

$$
F_{trend} =
\begin{cases}
1, & P_{current} > MA_{20} \
0, & \text{otherwise}
\end{cases}
$$

---

### 4.5 止跌因子（Stabilization）

$$
F_{stable} =
\begin{cases}
1, & \min(P_{last\ 10}) \geq \min(P_{prev\ 10}) \
0, & \text{otherwise}
\end{cases}
$$

---

### 4.6 动量因子（Momentum）

$$
F_{mom} =
\begin{cases}
1, & R_{5} > 0 \
0, & \text{otherwise}
\end{cases}
$$

---

## 5. 🚦 状态过滤（State Filtering）

### 5.1 过滤目标

* 排除下跌趋势中的“伪低位”
* 排除高位出货结构
* 排除噪声信号

---

### 5.2 过滤函数

$$
Filter =
\begin{cases}
1, & F_{pos} < 0.4 \
& \land F_{stable} = 1 \
& \land F_{trend} = 1 \
& \land F_{mom} = 1 \
0, & \text{otherwise}
\end{cases}
$$

---

## 6. 📊 评分系统（Scoring Model）

### 6.1 总体评分

$$
Score = S_{structure} + S_{strength} + S_{position} + S_{trend}
$$

范围：

```
Score ∈ [0, 100]
```

---

### 6.2 子评分定义

#### (1) 资金结构评分

$$
S_{structure} = 25 \cdot F_{div} + 10 \cdot F_{duration}
$$

---

#### (2) 强度评分

```
> 0.12 → 25
0.08–0.12 → 15
0.05–0.08 → 8
< 0.05 → 0
```

---

#### (3) 位置评分

```
<0.3 → 20
0.3–0.5 → 15
0.5–0.7 → 8
>0.7 → 0
```

---

#### (4) 趋势评分

$$
S_{trend} = 10 \cdot F_{trend} + 5 \cdot F_{trend_strong} + 5 \cdot F_{stable}
$$

---

## 7. 🚀 触发机制（Trigger）

### 7.1 核心思想

```
不预测，等待主力行为确认
```

---

### 7.2 触发函数

$$
Trigger =
\begin{cases}
1, & SuperLarge_{today} > 0 \
& \land P_{close} > P_{open} \
& \land Volume > MA_{volume} \
0, & \text{otherwise}
\end{cases}
$$

---


## 9. 📈 收益评估（Evaluation）

### 9.1 标签定义

$$
Y =
\begin{cases}
1, & R_{future}(5) > 0.03 \
0, & \text{otherwise}
\end{cases}
$$

---

### 9.2 上涨概率

$$
P(up) = P(Y=1 \mid Features)
$$

---

### 9.3 期望收益

$$
E = p \cdot \mu_{gain} - (1 - p) \cdot \mu_{loss}
$$

---

## 10. 🤖 扩展模型（可选）

可使用：

* Logistic Regression

---

### 输入：

$$
X = [F_{div}, F_{strength}, F_{pos}, F_{trend}, F_{mom}, Volume, Volatility]
$$

---

### 输出：

$$
P(up \mid X)
$$



---

### 11.3 时间风险

```
持仓超过10天无表现 → 退出
```

---

## 12.  关键原则总结

```
1. 信号必须 强 + 稳 + 合理位置
2. 低位必须结合止跌
3. 不预测，只跟随
4. 资金结构必须配合价格行为验证
```

---
