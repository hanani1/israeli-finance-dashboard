import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Finance Dashboard',
    short_name: 'Finance',
    description: 'Private household finance dashboard',
    start_url: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#0f766e',
    orientation: 'portrait-primary',
  };
}
