import type { ConfigGroup } from 'cortico/core/types.ts';
import { pick, type Language, type LanguageTable } from 'cortico/core/language.ts';

interface FieldText { title: string; description: string }

interface ContextStageText {
  title: string;
  description: string;
  maxTokens: FieldText;
  keepRatio: FieldText;
  softRatio: FieldText;
  firstTurn: FieldText;
}

const TEXT: LanguageTable<ContextStageText> = {
  zh: {
    title: '上下文与交接',
    description: '模型窗口与单次输出上限在「模型供应商」页配置。上下文达到模型硬限制时由 Core 强制交接。',
    maxTokens: {
      title: '上下文阶段预算',
      description: '上下文超过阶段预算 × 软阈值比例时先提示；下一批结束时仍超出则交接。',
    },
    keepRatio: {
      title: '交接保留比例',
      description: '交接笔记的 token 预算 = 阶段预算 × 此比例。笔记保留最近内容，更早的部分只留计数。',
    },
    softRatio: {
      title: '软阈值比例',
      description: '上下文预警阈值 = 阶段预算 × 此比例。',
    },
    firstTurn: {
      title: '合成首轮对话',
      description: '把部署 prompts/ 里的首轮对话(FIRST_TURN_USER / THINKING / REPLY)作为合成开头送进每次请求,不写入 session;内容为空时不送。',
    },
  },
  'zh-Hant': {
    title: '上下文與交接',
    description: '模型視窗與單次輸出上限在「模型供應商」頁設定。上下文達到模型硬限制時由 Core 強制交接。',
    maxTokens: {
      title: '上下文階段預算',
      description: '上下文超過階段預算 × 軟閾值比例時先提示；下一批結束時仍超出則交接。',
    },
    keepRatio: {
      title: '交接保留比例',
      description: '交接筆記的 token 預算 = 階段預算 × 此比例。筆記保留最近內容，更早的部分只留計數。',
    },
    softRatio: {
      title: '軟閾值比例',
      description: '上下文預警閾值 = 階段預算 × 此比例。',
    },
    firstTurn: {
      title: '合成首輪對話',
      description: '把部署 prompts/ 裡的首輪對話(FIRST_TURN_USER / THINKING / REPLY)作為合成開頭送進每次請求，不寫入 session;內容為空時不送。',
    },
  },
  en: {
    title: 'Context and handoff',
    description: 'The model window and the per-call output limit are set on the Model connections page. When the context reaches the model\'s hard limit, Core forces a handoff.',
    maxTokens: {
      title: 'Context stage budget',
      description: 'When the context exceeds stage budget × soft threshold ratio, the Persona is warned first; if it still exceeds it when the next batch ends, a handoff follows.',
    },
    keepRatio: {
      title: 'Handoff keep ratio',
      description: 'Token budget of the handoff note = stage budget × this ratio. The note keeps the most recent content; older parts are reduced to counts.',
    },
    softRatio: {
      title: 'Soft threshold ratio',
      description: 'Context warning threshold = stage budget × this ratio.',
    },
    firstTurn: {
      title: 'Synthetic first turn',
      description: 'Sends the first-turn dialogue in the deployment\'s prompts/ (FIRST_TURN_USER / THINKING / REPLY) as a synthetic opening with every request, without writing it to the session. Nothing is sent when it is empty.',
    },
  },
  ja: {
    title: 'コンテキストと引き継ぎ',
    description: 'モデルのウィンドウと 1 回の出力上限は「モデル接続」ページで設定します。コンテキストがモデルのハードリミットに達すると、Core が強制的に引き継ぎを行います。',
    maxTokens: {
      title: 'コンテキスト段階予算',
      description: 'コンテキストが段階予算 × ソフトしきい値比率を超えるとまず通知し、次のバッチ終了時にも超えていれば引き継ぎます。',
    },
    keepRatio: {
      title: '引き継ぎ保持比率',
      description: '引き継ぎノートの token 予算 = 段階予算 × この比率。ノートには最近の内容を残し、それより前の部分は件数だけを残します。',
    },
    softRatio: {
      title: 'ソフトしきい値比率',
      description: 'コンテキストの警告しきい値 = 段階予算 × この比率。',
    },
    firstTurn: {
      title: '合成の初回対話',
      description: 'デプロイの prompts/ にある初回対話(FIRST_TURN_USER / THINKING / REPLY)を合成の冒頭として毎回のリクエストに含めます。session には書き込みません。内容が空なら送りません。',
    },
  },
  ko: {
    title: '컨텍스트와 인계',
    description: '모델 창과 1회 출력 한도는 「모델 연결」 페이지에서 설정합니다. 컨텍스트가 모델의 하드 한도에 도달하면 Core가 인계를 강제합니다.',
    maxTokens: {
      title: '컨텍스트 단계 예산',
      description: '컨텍스트가 단계 예산 × 소프트 임계값 비율을 넘으면 먼저 알리고, 다음 배치가 끝날 때도 넘어 있으면 인계합니다.',
    },
    keepRatio: {
      title: '인계 보존 비율',
      description: '인계 노트의 token 예산 = 단계 예산 × 이 비율. 노트에는 최근 내용을 남기고, 그 이전 부분은 개수만 남깁니다.',
    },
    softRatio: {
      title: '소프트 임계값 비율',
      description: '컨텍스트 경고 임계값 = 단계 예산 × 이 비율.',
    },
    firstTurn: {
      title: '합성 첫 대화',
      description: '배포의 prompts/에 있는 첫 대화(FIRST_TURN_USER / THINKING / REPLY)를 합성된 시작으로 매 요청에 함께 보냅니다. session에는 기록하지 않으며, 내용이 비어 있으면 보내지 않습니다.',
    },
  },
  fr: {
    title: 'Contexte et passation',
    description: 'La fenêtre du modèle et la limite de sortie par appel se règlent sur la page Connexions de modèles. Quand le contexte atteint la limite stricte du modèle, le Core force une passation.',
    maxTokens: {
      title: 'Budget de l\'étape de contexte',
      description: 'Quand le contexte dépasse budget de l\'étape × ratio du seuil souple, la Persona est d\'abord avertie ; s\'il le dépasse encore à la fin du lot suivant, la passation a lieu.',
    },
    keepRatio: {
      title: 'Ratio conservé à la passation',
      description: 'Budget en tokens de la note de passation = budget de l\'étape × ce ratio. La note garde le contenu le plus récent ; les parties plus anciennes ne sont plus que des décomptes.',
    },
    softRatio: {
      title: 'Ratio du seuil souple',
      description: 'Seuil d\'avertissement du contexte = budget de l\'étape × ce ratio.',
    },
    firstTurn: {
      title: 'Premier échange synthétique',
      description: 'Envoie le premier échange placé dans prompts/ du déploiement (FIRST_TURN_USER / THINKING / REPLY) comme ouverture synthétique de chaque requête, sans l\'écrire dans la session. Rien n\'est envoyé s\'il est vide.',
    },
  },
  de: {
    title: 'Kontext und Übergabe',
    description: 'Modellfenster und Ausgabelimit pro Aufruf werden auf der Seite Modellverbindungen eingestellt. Erreicht der Kontext das harte Limit des Modells, erzwingt der Core eine Übergabe.',
    maxTokens: {
      title: 'Phasenbudget des Kontexts',
      description: 'Überschreitet der Kontext Phasenbudget × Verhältnis der weichen Schwelle, wird zuerst gewarnt; liegt er am Ende des nächsten Batches noch darüber, folgt die Übergabe.',
    },
    keepRatio: {
      title: 'Behaltanteil bei der Übergabe',
      description: 'Token-Budget der Übergabenotiz = Phasenbudget × dieser Anteil. Die Notiz behält die jüngsten Inhalte; ältere Teile bleiben nur als Anzahl erhalten.',
    },
    softRatio: {
      title: 'Verhältnis der weichen Schwelle',
      description: 'Warnschwelle des Kontexts = Phasenbudget × dieses Verhältnis.',
    },
    firstTurn: {
      title: 'Synthetische erste Runde',
      description: 'Sendet die erste Runde aus prompts/ der Bereitstellung (FIRST_TURN_USER / THINKING / REPLY) als synthetischen Anfang mit jeder Anfrage, ohne sie in die Session zu schreiben. Ist sie leer, wird nichts gesendet.',
    },
  },
  'es-419': {
    title: 'Contexto y traspaso',
    description: 'La ventana del modelo y el límite de salida por llamada se configuran en la página Conexiones de modelo. Cuando el contexto llega al límite estricto del modelo, el Core fuerza un traspaso.',
    maxTokens: {
      title: 'Presupuesto de la etapa de contexto',
      description: 'Cuando el contexto supera presupuesto de la etapa × proporción del umbral blando, primero se avisa; si al terminar el siguiente lote sigue por encima, se hace el traspaso.',
    },
    keepRatio: {
      title: 'Proporción conservada en el traspaso',
      description: 'Presupuesto de tokens de la nota de traspaso = presupuesto de la etapa × esta proporción. La nota conserva el contenido más reciente; de las partes anteriores solo quedan conteos.',
    },
    softRatio: {
      title: 'Proporción del umbral blando',
      description: 'Umbral de aviso del contexto = presupuesto de la etapa × esta proporción.',
    },
    firstTurn: {
      title: 'Primer turno sintético',
      description: 'Envía el primer turno de prompts/ del despliegue (FIRST_TURN_USER / THINKING / REPLY) como apertura sintética en cada solicitud, sin escribirlo en la session. Si está vacío, no se envía nada.',
    },
  },
  'pt-BR': {
    title: 'Contexto e transferência',
    description: 'A janela do modelo e o limite de saída por chamada são configurados na página Conexões de modelo. Quando o contexto atinge o limite rígido do modelo, o Core força uma transferência.',
    maxTokens: {
      title: 'Orçamento da etapa de contexto',
      description: 'Quando o contexto passa de orçamento da etapa × proporção do limite flexível, primeiro há um aviso; se ainda passar ao fim do próximo lote, ocorre a transferência.',
    },
    keepRatio: {
      title: 'Proporção mantida na transferência',
      description: 'Orçamento de tokens da nota de transferência = orçamento da etapa × esta proporção. A nota mantém o conteúdo mais recente; das partes anteriores ficam só contagens.',
    },
    softRatio: {
      title: 'Proporção do limite flexível',
      description: 'Limite de aviso do contexto = orçamento da etapa × esta proporção.',
    },
    firstTurn: {
      title: 'Primeiro turno sintético',
      description: 'Envia o primeiro turno de prompts/ da implantação (FIRST_TURN_USER / THINKING / REPLY) como abertura sintética em cada requisição, sem gravá-lo na session. Se estiver vazio, nada é enviado.',
    },
  },
  it: {
    title: 'Contesto e passaggio di consegne',
    description: 'La finestra del modello e il limite di uscita per chiamata si impostano nella pagina Connessioni ai modelli. Quando il contesto raggiunge il limite rigido del modello, il Core forza un passaggio di consegne.',
    maxTokens: {
      title: 'Budget della fase di contesto',
      description: 'Quando il contesto supera budget della fase × rapporto della soglia morbida, prima arriva un avviso; se alla fine del lotto successivo è ancora oltre, segue il passaggio di consegne.',
    },
    keepRatio: {
      title: 'Quota mantenuta nel passaggio',
      description: 'Budget in token della nota di passaggio = budget della fase × questa quota. La nota conserva i contenuti più recenti; delle parti precedenti restano solo i conteggi.',
    },
    softRatio: {
      title: 'Rapporto della soglia morbida',
      description: 'Soglia di avviso del contesto = budget della fase × questo rapporto.',
    },
    firstTurn: {
      title: 'Primo turno sintetico',
      description: 'Invia il primo turno in prompts/ della distribuzione (FIRST_TURN_USER / THINKING / REPLY) come apertura sintetica a ogni richiesta, senza scriverlo nella session. Se è vuoto non viene inviato nulla.',
    },
  },
  ru: {
    title: 'Контекст и передача',
    description: 'Окно модели и предел вывода за один вызов задаются на странице «Подключения к моделям». Когда контекст достигает жёсткого предела модели, Core принудительно выполняет передачу контекста.',
    maxTokens: {
      title: 'Бюджет этапа контекста',
      description: 'Когда контекст превышает бюджет этапа × долю мягкого порога, сначала приходит предупреждение; если к концу следующего пакета превышение остаётся, выполняется передача.',
    },
    keepRatio: {
      title: 'Доля, сохраняемая при передаче',
      description: 'Бюджет token заметки о передаче = бюджет этапа × эта доля. Заметка сохраняет последние материалы; от более ранних остаются только счётчики.',
    },
    softRatio: {
      title: 'Доля мягкого порога',
      description: 'Порог предупреждения о контексте = бюджет этапа × эта доля.',
    },
    firstTurn: {
      title: 'Синтетический первый ход',
      description: 'Отправляет первый ход из prompts/ развёртывания (FIRST_TURN_USER / THINKING / REPLY) синтетическим началом каждого запроса, не записывая его в session. Если он пуст, ничего не отправляется.',
    },
  },
};

/**
 * 上下文阶段三个裁量与首轮对话开关(`ContextStagePolicy`)的 WebUI 配置组，文案按请求语言。归属
 * `persona`:容量与首轮对话都是 Persona 的参数,core 只持 `hardTokens` 物理钳制与 keepPastThinking。
 * 渲染在 Persona 页的配置页签。
 *
 * 每个以 Cormini 为骨架的 bot 各声明一次,`id` 按 bot 取;没有这一组的 bot,这三个数在
 * WebUI 上没有位置,只能改 config.json。
 */
export function contextStageConfigGroup(id: string, language: Language): ConfigGroup {
  const t = pick(language, TEXT);
  return {
    id,
    owner: 'persona',
    schema: {
      type: 'object',
      title: t.title,
      description: t.description,
      properties: {
        'context.maxTokens': {
          type: 'integer',
          title: t.maxTokens.title,
          minimum: 8000,
          maximum: 2_000_000,
          multipleOf: 1000,
          'x-suffix': 'tok',
          'x-hot': true,
          description: t.maxTokens.description,
        },
        'context.keepRatio': {
          type: 'number',
          title: t.keepRatio.title,
          minimum: 0.05,
          maximum: 0.9,
          multipleOf: 0.01,
          'x-suffix': '×',
          'x-hot': true,
          description: t.keepRatio.description,
        },
        'context.softRatio': {
          type: 'number',
          title: t.softRatio.title,
          minimum: 0.1,
          maximum: 1,
          multipleOf: 0.01,
          'x-suffix': '×',
          'x-hot': true,
          description: t.softRatio.description,
        },
        'context.firstTurn': {
          type: 'boolean',
          title: t.firstTurn.title,
          'x-hot': true,
          description: t.firstTurn.description,
        },
      },
    },
  };
}
