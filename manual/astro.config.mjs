import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://zonuexe.github.io',
  base: '/riida',
  integrations: [
    starlight({
      title: 'riida',
      description: 'ローカルのPDF・EPUBコレクションのためのデスクトップ読書アプリ',
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
