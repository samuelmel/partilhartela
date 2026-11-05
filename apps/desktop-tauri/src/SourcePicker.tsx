import { useEffect, useRef, useState, type JSX } from 'react';
import { CloseIcon, RefreshIcon } from '../../../shared/ui/icons';

export type CaptureSource = {
  id: string;
  kind: 'screen' | 'window';
  title: string;
  thumbnail?: string;
  pid?: number | null;
  /** Janela minimizada: o app a restaura ao começar a transmitir. */
  minimized?: boolean;
};

/** Escolha de tela ou janela, com miniaturas. `sources` vem do comando `list_sources` do Rust. */
export function SourcePicker({
  sources,
  loading,
  starting,
  error,
  onClose,
  onRefresh,
  onSelect
}: {
  sources: CaptureSource[];
  loading: boolean;
  starting: boolean;
  error: string;
  onClose: () => void;
  onRefresh: () => void;
  onSelect: (source: CaptureSource) => void;
}): JSX.Element {
  const [tab, setTab] = useState<'screen' | 'window'>('screen');
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const filtered = sources.filter((source) => source.kind === tab);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title" tabIndex={-1}>
        <header className="modal-head">
          <div>
            <h2 id="share-title">O que você quer transmitir?</h2>
            <p>Clique numa tela ou janela para começar.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar"><CloseIcon /></button>
        </header>

        <div className="modal-tabs" role="tablist" aria-label="Tipo de fonte">
          <button type="button" role="tab" aria-selected={tab === 'screen'} onClick={() => setTab('screen')}>Telas</button>
          <button type="button" role="tab" aria-selected={tab === 'window'} onClick={() => setTab('window')}>Janelas</button>
          <button type="button" className="btn btn-quiet modal-refresh" onClick={onRefresh} disabled={loading || starting}>
            <RefreshIcon size={16} />Atualizar lista
          </button>
        </div>

        <div className="modal-body" role="tabpanel" aria-busy={loading || starting}>
          {loading ? (
            <p className="modal-empty"><span className="spinner" aria-hidden="true" />Procurando telas e janelas…</p>
          ) : filtered.length === 0 ? (
            <p className="modal-empty">Nenhuma {tab === 'screen' ? 'tela' : 'janela'} encontrada. Abra o programa e clique em Atualizar lista.</p>
          ) : (
            <div className="sources">
              {filtered.map((source) => (
                <button key={source.id} type="button" className="source" onClick={() => onSelect(source)} disabled={starting}>
                  {source.thumbnail ? <img src={source.thumbnail} alt="" /> : <span className="source-blank" aria-hidden="true" />}
                  <span className="source-name">
                    <span>{source.title}</span>
                    {source.minimized && <small className="source-tag">minimizada</small>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        {starting && <p className="modal-foot" role="status"><span className="spinner" aria-hidden="true" />Iniciando a transmissão…</p>}
      </section>
    </div>
  );
}
