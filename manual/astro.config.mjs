import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://zonuexe.github.io',
  base: '/riida',
  integrations: [
    starlight({
      title: 'riida',
      description: 'ローカルのPDF・EPUBコレクションのためのデスクトップ読書アプリ',
      head: [
        { tag: 'meta', attrs: { property: 'og:type', content: 'website' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary' } },
        {
          tag: 'script',
          attrs: { type: 'application/ld+json' },
          content: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'riida ユーザーマニュアル',
            url: 'https://zonuexe.github.io/riida/',
            description: 'ローカルのPDF・EPUBコレクションのためのデスクトップ読書アプリ',
            inLanguage: ['ja', 'en'],
            about: {
              '@type': 'SoftwareApplication',
              name: 'riida',
              applicationCategory: 'UtilitiesApplication',
              operatingSystem: ['macOS', 'Windows', 'Linux'],
            },
          }),
        },
      ],
      defaultLocale: 'root',
      locales: {
        root: {
          label: '日本語',
          lang: 'ja',
        },
        en: {
          label: 'English',
          lang: 'en',
        },
      },
      social: {
        github: 'https://github.com/zonuexe/riida',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'はじめに',
          translations: { en: 'Getting Started' },
          items: [
            { slug: 'introduction' },
            { slug: 'installation' },
          ],
        },
        {
          label: 'ライブラリ管理',
          translations: { en: 'Library Management' },
          items: [
            { slug: 'library-setup' },
            { slug: 'organizing' },
          ],
        },
        {
          label: '読書',
          translations: { en: 'Reading' },
          items: [
            { slug: 'reading-pdf' },
            { slug: 'reading-epub' },
          ],
        },
        {
          label: 'カスタマイズ',
          translations: { en: 'Customization' },
          items: [
            { slug: 'themes' },
            { slug: 'viewer-settings' },
          ],
        },
      ],
    }),
  ],
});
