/**
 * Winston 日誌服務
 * 提供結構化的日誌記錄和管理
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

// 確保日誌目錄存在
const logDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// 自定義日誌格式
const customFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss.SSS'
  }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} [${level.toUpperCase()}] ${message}`;

    // 加入 metadata
    if (Object.keys(metadata).length > 0) {
      msg += ` ${JSON.stringify(metadata)}`;
    }

    return msg;
  })
);

// 控制台輸出格式（彩色）
const consoleFormat = winston.format.combine(
  winston.format.timestamp({
    format: 'HH:mm:ss.SSS'
  }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} ${level}: ${message}`;

    // 只在 debug 模式下顯示 metadata
    if (process.env.NODE_ENV === 'development' && Object.keys(metadata).length > 0) {
      msg += ` ${JSON.stringify(metadata, null, 2)}`;
    }

    return msg;
  })
);

// 日誌等級定義
const logLevels = {
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
    trace: 5
  },
  colors: {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'blue',
    trace: 'gray'
  }
};

winston.addColors(logLevels.colors);

// 創建日誌輪轉配置
const createRotateTransport = (filename: string, level?: string) => {
  return new DailyRotateFile({
    filename: path.join(logDir, `${filename}-%DATE%.log`),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d',
    level: level || 'info',
    format: customFormat
  });
};

// 創建 Winston Logger 實例
const logger = winston.createLogger({
  levels: logLevels.levels,
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  format: customFormat,
  defaultMeta: { service: 'taxi-server' },
  transports: [
    // 錯誤日誌檔案
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      format: customFormat
    }),

    // 所有日誌輪轉檔案
    createRotateTransport('combined'),

    // 應用程式日誌輪轉檔案
    createRotateTransport('app', 'info'),

    // 資料庫查詢日誌
    createRotateTransport('database', 'debug'),

    // Socket 連線日誌
    createRotateTransport('socket', 'debug'),

    // API 請求日誌
    createRotateTransport('api', 'http')
  ],
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(logDir, 'exceptions.log')
    })
  ],
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(logDir, 'rejections.log')
    })
  ]
});

// 開發環境加入控制台輸出
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: consoleFormat,
    handleExceptions: true,
    handleRejections: true
  }));
}

// 特定類別的日誌記錄器
export const dbLogger = logger.child({ category: 'database' });
export const socketLogger = logger.child({ category: 'socket' });
export const apiLogger = logger.child({ category: 'api' });
export const cacheLogger = logger.child({ category: 'cache' });
export const dispatchLogger = logger.child({ category: 'dispatch' });

// HTTP 請求日誌中間件
export const httpLogger = winston.createLogger({
  level: 'http',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    createRotateTransport('http', 'http')
  ]
});

// Express 中間件
export const requestLogger = (req: any, res: any, next: any) => {
  const start = Date.now();

  // 記錄請求
  apiLogger.http('Incoming request', {
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });

  // 攔截回應
  const originalSend = res.send;
  res.send = function(data: any) {
    const duration = Date.now() - start;

    apiLogger.http('Request completed', {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      contentLength: res.get('content-length')
    });

    // 記錄錯誤回應
    if (res.statusCode >= 400) {
      apiLogger.error('Request error', {
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        body: req.body,
        error: data
      });
    }

    originalSend.call(this, data);
  };

  next();
};

// 資料庫查詢日誌
export const logDatabaseQuery = (text: string, params: any[], duration: number, rowCount: number) => {
  dbLogger.debug('Database query', {
    query: text.substring(0, 200), // 限制長度
    params: params?.slice(0, 5), // 只記錄前5個參數
    duration: `${duration}ms`,
    rowCount
  });

  // 慢查詢警告（超過1秒）
  if (duration > 1000) {
    dbLogger.warn('Slow query detected', {
      query: text,
      duration: `${duration}ms`,
      rowCount
    });
  }
};

// Socket 事件日誌
export const logSocketEvent = (event: string, socketId: string, data?: any) => {
  socketLogger.debug('Socket event', {
    event,
    socketId,
    data: data ? JSON.stringify(data).substring(0, 200) : undefined
  });
};

// 效能監控日誌
export const performanceLogger = {
  startTimer: (operation: string) => {
    const start = Date.now();
    return {
      end: (metadata?: any) => {
        const duration = Date.now() - start;
        logger.info(`Performance: ${operation}`, {
          duration: `${duration}ms`,
          ...metadata
        });

        if (duration > 3000) {
          logger.warn(`Slow operation: ${operation}`, {
            duration: `${duration}ms`,
            ...metadata
          });
        }
      }
    };
  }
};

// 錯誤日誌輔助函數
export const logError = (error: Error, context?: any) => {
  logger.error(error.message, {
    stack: error.stack,
    name: error.name,
    ...context
  });
};

// 審計日誌
export const auditLogger = {
  logAdminAction: (adminId: string, action: string, details: any) => {
    logger.info('Admin action', {
      adminId,
      action,
      details,
      timestamp: new Date().toISOString()
    });
  },

  logSecurityEvent: (event: string, details: any) => {
    logger.warn('Security event', {
      event,
      details,
      timestamp: new Date().toISOString()
    });
  }
};

// 系統狀態日誌
export const systemLogger = {
  logStartup: (config: any) => {
    logger.info('System startup', {
      nodeVersion: process.version,
      environment: process.env.NODE_ENV,
      port: config.port,
      pid: process.pid
    });
  },

  logShutdown: (reason: string) => {
    logger.info('System shutdown', {
      reason,
      uptime: process.uptime()
    });
  },

  logMemoryUsage: () => {
    const usage = process.memoryUsage();
    logger.debug('Memory usage', {
      rss: `${Math.round(usage.rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
      external: `${Math.round(usage.external / 1024 / 1024)}MB`
    });
  }
};

// 定期記錄系統狀態（每小時）
setInterval(() => {
  systemLogger.logMemoryUsage();
}, 3600000);

// 匯出主要 logger
export default logger;