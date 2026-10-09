import type { consoleEn, panelEn } from './strings.ts';

export const consoleText: Partial<typeof consoleEn> = {
  orientation: 'Cómo existe la Persona y notas sobre su metacognición.',
  constitution: 'Los principios a largo plazo de la Persona. Los cambios se aplican tras recargar el prefijo del sistema o al iniciar un contexto nuevo.',
  memoryNote: 'Convenciones de memoria: cómo se guardan sus archivos y cuándo aparecen por sí solos.',
  workspaceLabel: 'Espacio de trabajo (archivos de memoria que ella misma escribió)',
  workspaceNote: 'Se borran de forma irrecuperable todos los archivos del espacio de trabajo excepto la constitución; la constitución y los puntos de control de la personalidad no se tocan',
  workspaceStat: (n: number) => `${n} archivo${n === 1 ? '' : 's'} (además de la constitución)`,
  workspaceCleared: (n: number) => `Se ${n === 1 ? 'borró' : 'borraron'} ${n} archivo${n === 1 ? '' : 's'} del espacio de trabajo; la constitución no se tocó`,
  firstTurnUser: 'Primer turno · entrada del usuario',
  firstTurnUserDesc: 'El mensaje de usuario del primer turno sintetizado. Si este o la respuesta están vacíos, el turno completo no se inyecta.',
  firstTurnThinking: 'Primer turno · razonamiento',
  firstTurnThinkingDesc: 'El razonamiento (reasoning_content) del primer turno sintetizado del asistente; vacío = el turno no lleva ninguno. El dialecto openai-responses-compat no devuelve razonamiento, así que esta parte nunca se envía a esos endpoints.',
  firstTurnReply: 'Primer turno · respuesta',
  firstTurnReplyDesc: 'El texto de respuesta del asistente en el primer turno sintetizado.',
};
export const panelText: Partial<typeof panelEn> = {
  workspace: 'Espacio de trabajo',
  workspaceDesc: 'Al guardar se hace un commit en el repositorio Git del espacio de trabajo, con operator como autor.',
  history: 'Historial de versiones',
};
