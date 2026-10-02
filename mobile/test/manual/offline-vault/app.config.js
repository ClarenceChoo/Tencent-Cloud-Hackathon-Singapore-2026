module.exports = {
  name: 'Parse Vault Probe', slug: 'parse-vault-probe', version: '0.1.0',
  platforms: ['android', 'ios'], userInterfaceStyle: 'light',
  ios: { bundleIdentifier: 'sg.parse.vaultprobe' },
  android: { package: 'sg.parse.vaultprobe', allowBackup: false },
  plugins: [['expo-secure-store', { configureAndroidBackup: true,
    faceIDPermission: 'Unlock the fictional Parse storage probe.' }]],
};
