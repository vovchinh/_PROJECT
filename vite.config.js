import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
  let role = '';
  try {
    role = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString()).role || '';
  } catch {
    /* publishable keys are not JWTs */
  }
  if (key.startsWith('sb_secret_') || role === 'service_role')
    throw new Error(
      'Không được đưa secret/service_role key vào frontend. Dùng publishable key hoặc anon key.',
    );
  return {
    plugins: [react()],
    server: { port: 2000, strictPort: true },
    preview: { port: 4173, strictPort: true },
    test: { include: ['src/**/*.test.js'], environment: 'node' },
  };
});
