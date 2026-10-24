import { useState, type JSX } from 'react';

const avatarColors = ['#5d61e8', '#2f8f68', '#b8682a', '#a84a8f', '#2f7fb3', '#7b5cc9'];

function avatarColor(identity: string): string {
  let hash = 0;
  for (const char of identity) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return avatarColors[Math.abs(hash) % avatarColors.length];
}

/** Foto do Discord quando o participante entrou com login; inicial colorida se não tiver ou falhar. */
export function Avatar({ identity, name, url, small = false }: {
  identity: string;
  name: string;
  url?: string;
  small?: boolean;
}): JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string>();
  const className = `avatar ${small ? 'avatar-sm' : ''}`;
  if (url && failedUrl !== url) {
    return (
      <img
        className={`${className} avatar-img`}
        src={url}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(url)}
      />
    );
  }
  return (
    <span className={className} style={{ background: avatarColor(identity) }} aria-hidden="true">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
