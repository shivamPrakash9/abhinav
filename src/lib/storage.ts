import { createClient } from '@supabase/supabase-js';
import { env } from './env';

/**
 * Quiz image uploads (Supabase Storage).
 * 5MB image cap, allow-listed MIME types; the object key is namespaced per quiz
 * so deleting a quiz can clean up with a single prefix delete.
 */
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export async function uploadQuizImage(quizId: string, file: File): Promise<{ url: string } | { error: string }> {
  if (!ALLOWED.has(file.type)) return { error: 'Only PNG, JPEG, WebP or GIF images are allowed.' };
  if (file.size > MAX_BYTES) return { error: 'Images must be 5MB or smaller.' };
  const { url, serviceRoleKey, bucket } = env.supabase;
  if (!url || !serviceRoleKey) return { error: 'Image storage is not configured.' };
  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'gif';
  const key = `${quizId}/${crypto.randomUUID()}.${ext}`;
  const client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.storage.from(bucket).upload(key, file, { contentType: file.type, upsert: false });
  if (error) return { error: error.message };
  const { data } = client.storage.from(bucket).getPublicUrl(key);
  return { url: data.publicUrl };
}
