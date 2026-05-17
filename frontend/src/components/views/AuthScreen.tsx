import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { GlassCard } from '@/components/ui/custom/GlassCard';
import { api } from '@/services/api';

interface AuthScreenProps {
  onLogin: (data: { access_token: string }) => void;
}

export function AuthScreen({ onLogin }: AuthScreenProps) {
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

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
          } catch {}
          throw new Error(errMsg);
        }

        const data = await res.json();
        onLogin(data);
      } else {
        await api.post('/api/register', { username, password }, { skipAuth: true });
        setError('');
        setIsLogin(true);
      }
    } catch (err) {
      setError((err as Error).message || '登录失败，请重试');
    } finally {
      setLoading(false);
    }
  };

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
            >
              {loading ? (
                <Loader2 className="animate-spin" size={20} />
              ) : (
                isLogin ? 'Sign In' : 'Create Account'
              )}
            </Button>
          </form>

          <div className="mt-6 text-center">
            <button
              onClick={() => { setIsLogin(!isLogin); setError(''); }}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {isLogin ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
            </button>
          </div>
        </GlassCard>
      </div>
    </div>
  );
};
