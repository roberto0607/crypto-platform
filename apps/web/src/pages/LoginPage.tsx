import { useState, useRef, useEffect, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AxiosError } from "axios";
import { useAuthStore } from "@/stores/authStore";
import { login } from "@/api/endpoints/auth";
import { normalizeApiError } from "@/lib/errors";
import type { LegacyApiError, V1ApiError } from "@/types/api";
import Input from "@/components/Input";
import Button from "@/components/Button";
import ErrorBanner from "@/components/ErrorBanner";

export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await login(email, password);
      setAuth(res.data.accessToken, res.data.user);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      const { message } = normalizeApiError(
        err as AxiosError<LegacyApiError | V1ApiError>,
      );
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h1 className="text-2xl font-bold text-white text-center">Log in</h1>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <Input
        ref={emailRef}
        id="email"
        label="Email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <Input
        id="password"
        label="Password"
        type="password"
        required
        minLength={8}
        maxLength={72}
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      <Button type="submit" loading={submitting} className="w-full">
        Log in
      </Button>

      <p className="text-center text-sm text-gray-400">
        Don&apos;t have an account?{" "}
        <Link to="/register" className="text-blue-400 hover:text-blue-300">
          Register
        </Link>
      </p>
    </form>
  );
}
