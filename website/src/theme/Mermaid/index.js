import React from 'react';
import { useColorMode } from '@docusaurus/theme-common';
import Mermaid from '@theme-original/Mermaid';

export default function ThemeMermaid(props) {
  const { colorMode } = useColorMode();
  // A fresh instance prevents an earlier render from removing the new theme's SVG.
  return <Mermaid key={colorMode} {...props} />;
}
