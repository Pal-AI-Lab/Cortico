Cortico 是什么

Cortico 是基于事件流的 Agent Harness
Cortico 支持自主响应、持续运行、混合输入、实时输入场景的智能体开发，适用于人格 Bot 、AI 主播、角色扮演、聊天陪伴等多种下游任务。

Cortico 不是什么

Cortico 不是问答式聊天 Bot 框架
Cortico 不是一个预设的角色/人格或记忆方案
Cortico 不是面向解决用户问题或完成编码任务的 Agent Harness / Coding Agent

Cortico的四层设计

Cortico Core

Core 持有 session、事件流和模型调用的生命周期，以及相关的机械管理，它处理事件投递、调度、上下文交接、工具派发、容量控制、错误隔离以及 LLM Provider 等底层事务，提供通用 Hook 和运行原语，它不拥有、解释或生成任何语义内容。

Cortico Persona

Persona 定义一类 Cortico Bot 的基本语义和运转方式，包括上下文构造、session 声明、认知流程、内部提示、上下文交接策略，以及对 Memory 的解释和操作协议。Persona 还提供读取和修改 Memory 的工具。
Persona 是可复用的 Bot 类型，而不是某一个具体 Bot 个体。一个 Persona 类通常与一个 Memory 类绑定，但 Persona 类下的不同实例可以持有不同的 Memory 实例，形成共享运作逻辑和 Memory 管理方法、但具有不同个体经历的多个 Bot 。

Cortico Memory

Memory 是Cortico Bot的内部持久化状态的唯一权威载体。Memory 本身是被动的；它通过 Persona 定义的协议和工具被理解、读取与修改。
Memory 的具体形式不受 Cortico 规定，它可以是文件工作区、结构化数据库、对象存储或其他介质。Persona 拥有相应 Memory 形式的语义解释权；Core 只将其视为不透明内容。

Cortico World

World 是 Cortico Bot 与外部环境交互的唯一边界。它定义 Agent 对该环境的输入（工具定义、解析和执行、回执）和输出（事件定义），具体来说，World 将环境变化描述为 Agent 可观察的事件并通过事件流投递，并将 Agent 可以执行的外部行为声明为工具以供调用。World 可能直接托管对应环境（如：游戏进程），也可以仅作为对环境的观察和操作接口（如：IM平台）。
World 与具体的 Persona 实现不直接依赖，也不能调用彼此的程序接口，World 和 Bot 之间仅能通过事件投递和工具描述这样的语义化形式沟通。World 提供环境描述（系统提示词段）、事件和工具契约，Persona 在 session 内的语义层面理解这些内容，得到关于环境的信息，并通过工具调用对环境采取行动。

Cortico Bot

一个 Cortico Bot 实例对应一份可部署 Cortico Bot 的装配定义。它选择一个 Persona 和对应的 Memory，声明一组需要的 World ，提供部署配置和各个模块的初始配置

Cortico 的工程哲学（作为 AI Harness 的设计准则）：

1. 面向未来设计/自然兑现进步：Agent和AI的时代发展十分迅速，AI Harness 设计应该优先面向未来更大，更强，更快速的模型设计。不应该把当前可用模型的局限固化系统的局限。随着模型的各种能力增强，系统应该不用改写核心语义就能自然获得收益。为当前模型设计的各种妥协机制应当作为 Fallback 提供。

2. 最小先验干预：机械式和启发式的基础设施应该尽量不干涉模型的行为功能。基础设施应该在任何例外（例如：反应速度限制，安全边界等）发生之前显式声明，并在例外情况发生时告知模型。

3. 诚实的认知论：机械式和启发式的基础设施应该尽量不干涉模型的认知功能。基础设施应仅陈述系统能够确认的事实。每一处事件内容、工具回执都应该绑定，并可以还原为对基础设施而言可验证的事实，尽量避免启发式的推论。

Cortico 的人格 Bot 审美（非工程驱动的偏好）：

1. Memory 即人格：独立存在的人格 Bot 的主体性和连续性由它的 Memory 数据完全定义，决定和保证。模型替换、上下文交接和进程重启不会改变 Bot 的人格个体身份。
2. 主动性和自由性优先：最大限度保证人格 Bot 的主动性，尽量不强迫 Bot 做出认知/裁决/行为，以不行为为默认行为，允许Bot自行判断是否做出行动。需要约束和规范模型的行为时，除涉及硬安全边界、权限和不可逆副作用外，应尽量使用上下文语义约束代替机械阻拦。

---

# English

What Cortico is

Cortico is an Agent Harness built on an event stream.
Cortico supports building agents that respond on their own, run continuously, and take mixed and real-time input; it suits persona bots, AI streamers, roleplay, companionship and other downstream tasks.

What Cortico is not

Cortico is not a framework for question-and-answer chat bots.
Cortico is not a preset character, persona or memory scheme.
Cortico is not an Agent Harness / Coding Agent aimed at solving a user's problems or finishing coding tasks.

Cortico's four layers

Cortico Core

Core holds the lifecycle of sessions, the event stream and model calls, along with the mechanical management around them: event delivery, scheduling, context handoff, tool dispatch, capacity control, error isolation, LLM providers and other low-level matters. It offers general hooks and runtime primitives. It does not own, interpret or generate any semantic content.

Cortico Persona

Persona defines the basic semantics and the way one class of Cortico Bot runs: context construction, session declaration, cognitive flow, internal prompts, the context handoff strategy, and the interpretation of and operating protocol for Memory. Persona also provides the tools that read and modify Memory.
A Persona is a reusable bot type, not one concrete bot individual. A Persona class is usually bound to one Memory class, but different instances of that class can hold different Memory instances, giving several bots that share operating logic and Memory management while having different individual histories.

Cortico Memory

Memory is the only authoritative carrier of a Cortico Bot's internal persistent state. Memory itself is passive; it is understood, read and modified through the protocol and tools that Persona defines.
The concrete form of Memory is not prescribed by Cortico: it can be a file workspace, a structured database, object storage or another medium. Persona holds the semantic authority over that form; Core treats it as opaque content.

Cortico World

World is the only boundary between a Cortico Bot and one external environment. It defines the agent's input to that environment (tool definitions, parsing and execution, receipts) and its output (event definitions). Concretely, World describes environment changes as events the agent can observe and delivers them over the event stream, and declares the external behaviours the agent can perform as tools it may call. A World may host the environment directly (a game process, say), or serve only as an interface for observing and operating one (an IM platform, say).
World and a concrete Persona implementation do not depend on each other directly and cannot call each other's programmatic interfaces; World and Bot communicate only in semantic forms such as event delivery and tool descriptions. World supplies the environment description (a system prompt section), the event contract and the tool contract; Persona understands them at the semantic level inside a session, learns about the environment from them, and acts on it through tool calls.

Cortico Bot

One Cortico Bot instance corresponds to one assembly definition of a deployable Cortico Bot. It picks a Persona and the matching Memory, declares the set of Worlds it needs, and supplies the deployment configuration and the initial configuration of each module.

Cortico's engineering philosophy (design principles as an AI Harness):

1. Design for the future / let progress arrive on its own: agents and AI are moving fast, and an AI Harness should be designed first for the larger, stronger, faster models to come. The limits of today's available models must not be frozen into the limits of the system. As the models gain capability, the system should benefit from it without its core semantics being rewritten. Mechanisms that compromise for today's models belong in the system as fallbacks.

2. Minimal prior intervention: mechanical and heuristic infrastructure should interfere with the model's behavioural functions as little as possible. Infrastructure should declare every exception (a reaction-speed limit, a safety boundary) explicitly before it happens, and tell the model when it does happen.

3. Honest epistemology: mechanical and heuristic infrastructure should interfere with the model's cognitive functions as little as possible. Infrastructure should state only what the system can confirm. Every piece of event content and every tool receipt should be bound to, and reducible to, a fact the infrastructure can verify; heuristic inference should be avoided.

Cortico's taste in persona bots (preferences, not engineering):

1. Memory is the persona: the subjecthood and continuity of an independently existing persona bot are wholly defined, decided and guaranteed by its Memory data. Replacing the model, handing off the context and restarting the process do not change the bot's individual identity.
2. Autonomy and freedom come first: keep a persona bot's initiative as intact as possible, do not force it into a cognition, a judgement or an action, take inaction as the default behaviour, and let the bot decide for itself whether to act. Where the model's behaviour has to be constrained, use semantic constraints in the context rather than mechanical blocking, except for hard safety boundaries, permissions and irreversible side effects.
