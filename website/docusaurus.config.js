// @ts-check

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Agent Board',
  tagline: '本机 Agent 任务看板',
  favicon: 'img/favicon.svg',
  url: 'https://relay.mengfei.tech',
  baseUrl: '/docs/',
  trailingSlash: true,
  organizationName: 'mengfei0053',
  projectName: 'agent-board',
  onBrokenLinks: 'throw',
  markdown: { mermaid: true },
  themes: ['@docusaurus/theme-mermaid'],
  i18n: { defaultLocale: 'zh-Hans', locales: ['zh-Hans'] },
  presets: [
    ['classic', {
      docs: { routeBasePath: '/', sidebarPath: './sidebars.js' },
      blog: false,
      theme: { customCss: './src/css/custom.css' },
    }],
  ],
  themeConfig: {
    navbar: {
      title: 'Agent Board',
      items: [
        { to: '/', label: '文档', position: 'left' },
        { to: '/api/overview', label: 'API 参考', position: 'left' },
        { href: 'https://relay.mengfei.tech/admin', label: '返回控制台', position: 'right', target: '_self' },
        { href: 'https://github.com/mengfei0053/agent-board', label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      links: [{ title: '项目', items: [
        { label: 'GitHub', href: 'https://github.com/mengfei0053/agent-board' },
        { label: '问题反馈', href: 'https://github.com/mengfei0053/agent-board/issues' },
      ] }],
      copyright: `Copyright © ${new Date().getFullYear()} Agent Board.`,
    },
  },
};

export default config;
