import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import pino from 'pino';

let _logger: pino.Logger | null = null;
let _logsDir: string | null = null;

function getLogsDir(): string {
  if (_logsDir) return _logsDir;
  // dogfood #104-a：ORISON_LOG_DIR 重定向口（mirror main/index.ts ORISON_CDP_PORT 的 env 覆盖
  // 惯例）——测试/诊断时把日志目录引离真实 ~/.orison/logs；空串视同未设。
  const override = process.env.ORISON_LOG_DIR;
  const dir = override ? override : path.join(os.homedir(), '.orison', 'logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  _logsDir = dir;
  return dir;
}

function getCurrentLogFile(): string {
  const dir = getLogsDir();
  const today = new Date().toISOString().slice(0, 10);
  return path.join(dir, `desktop-${today}.log`);
}

function buildLogger(): pino.Logger {
  const isDev = !!process.env.ELECTRON_RENDERER_URL;
  // dogfood #104-a 测试隔离：logger 是唯一不认 electron mock 的全局单例——db 走 app.getPath
  // 可被测试 mock 引去 temp，getLogsDir 直读 os.homedir 引不走，任何 import 了 shell main
  // 模块图的测试首调 getLogger() 就在真实 ~/.orison/logs 开句柄写行。vitest 进程（VITEST
  // env 是 vitest 对测试进程的内置标记，全包通用）禁 file transport，stderr-only。设了
  // ORISON_LOG_DIR 则优先级更高（重定向到该目录——测试里想看日志时用）。e2e harness
  // 启动的是真 app（非 vitest 进程），行为不变。不引入 electron 依赖（logger 保持纯 node
  // 依赖面，preload/早期可用）。
  if (process.env.VITEST && !process.env.ORISON_LOG_DIR) {
    return pino(
      { level: isDev ? 'debug' : 'info' },
      pino.multistream([{ level: 'info', stream: process.stderr }]),
    );
  }
  const fileDest = pino.destination({ dest: getCurrentLogFile(), mkdir: true, sync: false });
  const streams: pino.StreamEntry[] = [{ level: 'info', stream: fileDest }];
  if (isDev) {
    streams.push({
      level: 'debug',
      stream: pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
      }),
    });
  }
  return pino({ level: isDev ? 'debug' : 'info' }, pino.multistream(streams));
}

export function getLogger(): pino.Logger {
  if (!_logger) _logger = buildLogger();
  return _logger;
}

export function getLogsDirPath(): string {
  return getLogsDir();
}

export function installGlobalErrorHandlers(): void {
  const logger = getLogger();
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandledRejection');
  });
}
