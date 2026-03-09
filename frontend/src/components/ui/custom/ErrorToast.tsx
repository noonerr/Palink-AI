import React from 'react';
import { AlertCircle, WifiOff, ServerCrash, Clock, Key, CheckCircle2, XCircle, HelpCircle } from 'lucide-react';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ErrorInfo, ErrorType } from '@/lib/errorHandler';

interface ErrorToastProps {
  errorInfo: ErrorInfo;
  onClose?: () => void;
  onRetry?: () => void;
  showRetry?: boolean;
  className?: string;
}

const errorIcons: Record<ErrorType, React.ReactNode> = {
  network: <WifiOff className="h-5 w-5 text-orange-500" />,
  server: <ServerCrash className="h-5 w-5 text-red-500" />,
  timeout: <Clock className="h-5 w-5 text-yellow-500" />,
  auth: <Key className="h-5 w-5 text-purple-500" />,
  validation: <XCircle className="h-5 w-5 text-red-500" />,
  model_unavailable: <HelpCircle className="h-5 w-5 text-blue-500" />,
  unknown: <AlertCircle className="h-5 w-5 text-gray-500" />
};

export const ErrorToast: React.FC<ErrorToastProps> = ({
  errorInfo,
  onClose,
  onRetry,
  showRetry = true,
  className = ''
}) => {
  const [showDetails, setShowDetails] = React.useState(false);

  return (
    <div className={`fixed bottom-4 right-4 z-50 max-w-md w-full ${className}`}>
      <Alert variant="destructive" className="border-l-4 border-orange-500 shadow-lg">
        <div className="flex items-start gap-3">
          {errorIcons[errorInfo.type]}
          <div className="flex-1">
            <AlertTitle className="text-base font-semibold flex items-center gap-2">
              {errorInfo.title}
            </AlertTitle>
            <AlertDescription className="mt-1">
              <p className="text-sm mb-2">{errorInfo.description}</p>
              <p className="text-sm text-orange-600 bg-orange-50 dark:bg-orange-950/30 rounded px-2 py-1 inline-flex items-center gap-1">
                <CheckCircle2 className="h-4 w-4" />
                {errorInfo.suggestion}
              </p>
              
              {errorInfo.technicalDetails && (
                <div className="mt-3">
                  <button
                    onClick={() => setShowDetails(!showDetails)}
                    className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline"
                  >
                    {showDetails ? '隐藏技术详情' : '显示技术详情'}
                  </button>
                  {showDetails && (
                    <div className="mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono text-gray-600 dark:text-gray-400 break-all">
                      {errorInfo.technicalDetails}
                    </div>
                  )}
                </div>
              )}
            </AlertDescription>
            
            <div className="mt-3 flex gap-2">
              {showRetry && onRetry && (
                <Button 
                  variant="default" 
                  size="sm"
                  onClick={onRetry}
                  className="bg-orange-600 hover:bg-orange-700"
                >
                  重试
                </Button>
              )}
              {onClose && (
                <Button 
                  variant="secondary" 
                  size="sm"
                  onClick={onClose}
                >
                  关闭
                </Button>
              )}
            </div>
          </div>
        </div>
      </Alert>
    </div>
  );
};

export default ErrorToast;
