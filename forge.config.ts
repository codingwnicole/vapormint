import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';

const certificateFile = process.env.WINDOWS_CERTIFICATE_FILE;
const certificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    ...(process.env.ELECTRON_ZIP_DIR ? { electronZipDir: process.env.ELECTRON_ZIP_DIR } : {}),
    executableName: 'Vapormint',
    icon: process.platform === 'darwin' ? 'assets/icon.icns' : 'assets/icon.ico',
    extraResource: ['./runtime', './scripts', './assets'],
  },
  makers: [new MakerSquirrel({
    name: 'Vapormint',
    setupExe: 'VapormintSetup.exe',
    setupIcon: 'assets/icon.ico',
    ...(certificateFile && certificatePassword ? { certificateFile, certificatePassword } : {}),
  }), new MakerDMG({ name: 'Vapormint' }), new MakerZIP({}, ['darwin'])],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.mts' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.mts' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.mts' }],
    }),
  ],
};

export default config;
