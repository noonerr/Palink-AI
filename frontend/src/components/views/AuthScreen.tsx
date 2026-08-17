import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { api } from '@/services/api';
import type { AuthConfig, OAuthProviderInfo } from '@/types';

interface AuthScreenProps {
  onLogin: (data: { access_token: string }) => void;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

export function AuthScreen({ onLogin }: AuthScreenProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);

  useEffect(() => {
    api.get<AuthConfig>('/api/auth/config', { skipAuth: true })
      .then(setAuthConfig)
      .catch(() => {
        setAuthConfig({
          local_login_enabled: true,
          local_register_enabled: true,
          oauth_providers: [],
        });
      });
  }, []);

  useEffect(() => {
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const searchParams = new URLSearchParams(window.location.search);
    const accessToken = hashParams.get('access_token') || searchParams.get('access_token');
    if (accessToken) {
      window.history.replaceState({}, '', window.location.pathname);
      onLogin({ access_token: accessToken });
    }
  }, [onLogin]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      if (isLogin) {
        const formData = new URLSearchParams();
        formData.append('username', username);
        formData.append('password', password);

        const res = await api.raw('/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData,
          skipAuth: true,
        });

        if (!res.ok) {
          let errMsg = '登录失败';
          try {
            const errJson = await res.json();
            errMsg = errJson.detail || errJson.message || errMsg;
          } catch {
            // 非 JSON 错误响应（如 nginx 限流 503 / 上游 502 等返回 HTML 页）：附带状态码，
            // 避免用户只看到笼统的"登录失败"后盲目重试——重试会进一步触发限流，形成死循环。
            const snippet = await res.text().then((t) => t.trim().slice(0, 100)).catch(() => '');
            console.error('[AuthScreen] login rejected with non-JSON response', { status: res.status, body: snippet });
            errMsg = `登录失败（HTTP ${res.status}${snippet ? ` - ${snippet}` : ''}）`;
          }
          throw new Error(errMsg);
        }

        const data = await res.json();
        onLogin(data);
      } else {
        await api.post('/api/register', { username, password }, { skipAuth: true });
        setError('');
        setIsLogin(true);
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err, '登录失败，请重试'));
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthLogin = async (providerName: string) => {
    setOauthLoading(providerName);
    setError('');
    try {
      const data = await api.get<{ login_url: string }>(
        `/api/auth/oauth/${providerName}/login-url`,
        { skipAuth: true }
      );
      window.location.href = data.login_url;
    } catch (err: unknown) {
      setError(getErrorMessage(err, '无法获取登录地址'));
      setOauthLoading(null);
    }
  };

  const oauthProviders: OAuthProviderInfo[] = authConfig?.oauth_providers || [];
  const showLocalLogin = authConfig?.local_login_enabled !== false;
  const showRegister = authConfig?.local_register_enabled !== false;
  const hasOAuth = oauthProviders.length > 0;

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative">
      <div className="w-full max-w-sm animate-fade-in-up">
        <GlassCard strong className="p-8">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-primary rounded-2xl mx-auto flex items-center justify-center mb-6 shadow-lg shadow-primary/30">
              <span className="text-primary-foreground text-2xl font-bold">P</span>
            </div>
            <h1 className="text-2xl font-semibold">Palink AI</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {isLogin ? 'Welcome back' : 'Create an account'}
            </p>
          </div>

          {error && (
            <div className="mb-4 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm text-center">
              {error}
            </div>
          )}

          {hasOAuth && (
            <>
              {oauthProviders.map((provider) => (
                <Button
                  key={provider.name}
                  type="button"
                  onClick={() => handleOAuthLogin(provider.name)}
                  disabled={oauthLoading === provider.name}
                  className="w-full h-12 mb-3"
                  variant="outline"
                >
                  {oauthLoading === provider.name ? (
                    <Loader2 className="animate-spin" size={20} />
                  ) : (
                    <span>{provider.display_name} 登录</span>
                  )}
                </Button>
              ))}

              {showLocalLogin && (
                <div className="relative my-4">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">或</span>
                  </div>
                </div>
              )}
            </>
          )}

          {showLocalLogin && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Input
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="Username"
                  className="h-12"
                  required
                />
              </div>
              <div>
                <Input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Password"
                  className="h-12"
                  required
                />
              </div>
              <Button
                type="submit"
                disabled={loading}
                className="w-full h-12"
                variant={hasOAuth ? 'outline' : 'default'}
              >
                {loading ? (
                  <Loader2 className="animate-spin" size={20} />
                ) : (
                  isLogin ? 'Sign In' : 'Create Account'
                )}
              </Button>
            </form>
          )}

          {showLocalLogin && (
            <div className="mt-6 text-center">
              {showRegister ? (
                <button
                  onClick={() => { setIsLogin(!isLogin); setError(''); }}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  {isLogin ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
                </button>
              ) : isLogin ? (
                <p className="text-xs text-muted-foreground">
                  本地注册已关闭，请使用第三方登录
                </p>
              ) : null}
            </div>
          )}

          {!hasOAuth && !showLocalLogin && (
            <div className="text-center py-8">
              <p className="text-muted-foreground">系统维护中，暂时无法登录</p>
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  );
};
