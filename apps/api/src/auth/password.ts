import argon2 from "argon2";

// Keep these limits the same as your zod schema
const MIN_LEN = 8;
const MAX_LEN = 72;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_LEN || password.length > MAX_LEN) {
    throw new Error("password_length_invalid");
  }

  // argon2id is the recommended variant
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB (matches your hash output)
    timeCost: 3,
    parallelism: 4,
  });
}

export async function verifyPassword(
  password: string,
  passwordHash: string
): Promise<boolean> {
  // argon2.verify handles salt + parameters embedded in the hash string
  return argon2.verify(passwordHash, password);
}
