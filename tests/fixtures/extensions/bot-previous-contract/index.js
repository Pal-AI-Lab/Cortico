export default {
  id: 'previous-bot',
  declares: ['terminal', { id: 'qq', label: 'QQ' }],
  defaults: () => ({ displayName: 'previous', worlds: {} }),
  build: () => ({
    persona: { console: (language) => ({ panels: [{ id: 'memory', title: language }] }) },
    console: {
      enabled: true,
      consolePages: ({ language }) => [{ id: 'persona:previous-bot', kind: 'persona', label: language }],
    },
  }),
};
