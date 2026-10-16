export default {
  id: 'previous-provider',
  title: '上一版契约的端点',
  reasoningTiers: [],
  serviceTiers: [],
  create: () => ({ client: { respond: async () => ({}) } }),
  console: (host) => ({ panels: [{ id: 'own', title: host.language }] }),
};
