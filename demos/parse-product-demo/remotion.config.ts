import {existsSync} from 'node:fs';
import {Config} from '@remotion/cli/config';
Config.setRspack(true);
Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(92);
Config.setOverwriteOutput(true);
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (process.env.REMOTION_BROWSER_EXECUTABLE) {
  Config.setBrowserExecutable(process.env.REMOTION_BROWSER_EXECUTABLE);
} else if (process.platform === 'darwin' && existsSync(localChrome)) {
  Config.setBrowserExecutable(localChrome);
}
Config.setConcurrency(2);
