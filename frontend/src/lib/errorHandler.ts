export type ErrorType = 
  | 'network' 
  | 'server' 
  | 'timeout' 
  | 'auth' 
  | 'validation' 
  | 'model_unavailable' 
  | 'unknown';

export interface ErrorInfo {
  type: ErrorType;
  title: string;
  description: string;
  suggestion: string;
  technicalDetails?: string;
}

const errorMessages: Record<ErrorType, Omit<ErrorInfo, 'technicalDetails'>> = {
  network: {
    type: 'network',
    title: '网络连接问题',
    description: '无法连接到服务器，请检查您的网络连接。',
    suggestion: '请检查网络连接是否正常，或稍后重试。'
  },
  server: {
    type: 'server',
    title: '服务器错误',
    description: '服务器遇到了问题，暂时无法处理您的请求。',
    suggestion: '请稍后重试，或联系管理员。'
  },
  timeout: {
    type: 'timeout',
    title: '请求超时',
    description: 'AI模型响应时间过长，可能是模型服务繁忙或网络延迟。',
    suggestion: '建议尝试其他模型，或稍后重试。'
  },
  auth: {
    type: 'auth',
    title: '认证失败',
    description: '您的登录状态已过期或认证信息无效。',
    suggestion: '请重新登录。'
  },
  validation: {
    type: 'validation',
    title: '输入验证错误',
    description: '您的输入包含无效内容，请检查后重试。',
    suggestion: '请检查您的输入内容是否符合要求。'
  },
  model_unavailable: {
    type: 'model_unavailable',
    title: '模型不可用',
    description: '当前选择的AI模型暂时不可用。',
    suggestion: '请尝试切换到其他可用的模型。'
  },
  unknown: {
    type: 'unknown',
    title: '发生错误',
    description: '发生了一个意外错误。',
    suggestion: '请稍后重试，或联系技术支持。'
  }
};

export function analyzeError(error: any): ErrorInfo {
  const errorMessage = error?.message || String(error);
  const errorString = errorMessage.toLowerCase();

  let errorType: ErrorType = 'unknown';
  
  if (error.name === 'AbortError' || errorString.includes('abort')) {
    return {
      ...errorMessages.unknown,
      type: 'unknown',
      title: '请求已取消',
      description: '您的请求已被取消。',
      suggestion: '如需继续，请重新发送消息。',
      technicalDetails: errorMessage
    };
  }

  if (errorString.includes('timeout') || errorString.includes('504')) {
    errorType = 'timeout';
  } else if (errorString.includes('network') || errorString.includes('fetch') || errorString.includes('cors')) {
    errorType = 'network';
  } else if (errorString.includes('500') || errorString.includes('502') || errorString.includes('503')) {
    errorType = 'server';
  } else if (errorString.includes('401') || errorString.includes('403') || errorString.includes('unauthorized') || errorString.includes('forbidden')) {
    errorType = 'auth';
  } else if (errorString.includes('400') || errorString.includes('validation')) {
    errorType = 'validation';
  } else if (errorString.includes('model') && (errorString.includes('not found') || errorString.includes('unavailable'))) {
    errorType = 'model_unavailable';
  }

  return {
    ...errorMessages[errorType],
    technicalDetails: errorMessage
  };
}
