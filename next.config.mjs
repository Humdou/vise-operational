/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // NEXT_DIST_DIR permet de compiler en production sans corrompre le cache
  // du serveur de développement (les deux écrivent sinon dans .next).
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

export default nextConfig;
