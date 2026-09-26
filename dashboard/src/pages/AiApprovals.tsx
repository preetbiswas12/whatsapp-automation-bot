import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Check,
  X,
  Trash2,
  Loader2,
  AlertCircle,
  Sparkles,
  BookMarked,
  Clock,
  Edit3,
  Save,
  XSquare,
  RefreshCw,
  Send,
} from 'lucide-react';
import type { AiApprovalItem, AiPattern } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import {
  useAiStatusQuery,
  useAiApprovalsQuery,
  useAiPatternsQuery,
  useAiApproveMutation,
  useAiRejectMutation,
  useAiDeletePatternMutation,
  useAiEditMutation,
  useAiAgentMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import './AiApprovals.css';

type Tab = 'pending' | 'resolved' | 'patterns';

const formatWhen = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
};

export function AiApprovals() {
  const { t } = useTranslation();
  useDocumentTitle(t('ai.title'));
  const { canWrite } = useRole();
  const toast = useToast();

  const approveMutation = useAiApproveMutation();
  const rejectMutation = useAiRejectMutation();
  const deletePatternMutation = useAiDeletePatternMutation();
  const editMutation = useAiEditMutation();
  const agentMutation = useAiAgentMutation();

  const {
    data: status,
    isLoading: loadingStatus,
    isError: statusError,
  } = useAiStatusQuery();
  const { data: approvals = [], isLoading: loadingApprovals, isError: approvalsError, refetch: refetchApprovals } = useAiApprovalsQuery();
  const { data: patterns = [], isLoading: loadingPatterns, isError: patternsError } = useAiPatternsQuery();

  const [tab, setTab] = useState<Tab>('pending');
  const [deleteTarget, setDeleteTarget] = useState<AiPattern | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentPhone, setAgentPhone] = useState('');
  const [showAgentInput, setShowAgentInput] = useState(false);

  const pending = approvals.filter(a => a.status === 'pending');
  const resolved = approvals.filter(a => a.status !== 'pending');

  const loading = (tab === 'patterns' ? loadingPatterns : loadingApprovals) || loadingStatus;

  const handleApprove = async (item: AiApprovalItem) => {
    try {
      await approveMutation.mutateAsync(item.id);
      toast.success(t('ai.toasts.approved'));
    } catch (err) {
      toast.error(
        t('ai.toasts.approveFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const handleReject = async (item: AiApprovalItem) => {
    try {
      await rejectMutation.mutateAsync(item.id);
      toast.success(t('ai.toasts.rejected'));
    } catch (err) {
      toast.error(
        t('ai.toasts.rejectFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const handleDeletePattern = async () => {
    if (!deleteTarget) return;
    try {
      await deletePatternMutation.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
      toast.success(t('ai.toasts.patternDeleted'));
    } catch (err) {
      toast.error(
        t('ai.toasts.patternDeleteFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const handleEditStart = (item: AiApprovalItem) => {
    setEditingId(item.id);
    setEditText(item.customReply ?? item.draftReply);
  };

  const handleAgentSend = async () => {
    if (!agentPrompt.trim() || !agentPhone.trim()) return;
    try {
      await agentMutation.mutateAsync({ prompt: agentPrompt.trim(), targetPhone: agentPhone.trim() });
      setAgentPrompt('');
      setAgentPhone('');
      setShowAgentInput(false);
      toast.success(t('ai.toasts.agentQueued'));
    } catch (err) {
      toast.error(
        t('ai.toasts.agentFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditText('');
  };

  const handleEditSave = async (item: AiApprovalItem) => {
    try {
      await editMutation.mutateAsync({ id: item.id, customReply: editText });
      setEditingId(null);
      setEditText('');
      toast.success(t('ai.toasts.editSuccess'));
    } catch (err) {
      toast.error(
        t('ai.toasts.editFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  const handleRefresh = async () => {
    try {
      toast.info(t('ai.toasts.refreshing'));
      await refetchApprovals();
      toast.success(t('ai.toasts.refreshSuccess'));
    } catch (err) {
      toast.error(
        t('ai.toasts.refreshFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      );
    }
  };

  if (loading) {
    return (
      <div
        className="ai-approvals-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="ai-approvals-page">
      <PageHeader title={t('ai.title')} subtitle={t('ai.subtitle')} />

      {(statusError || approvalsError || patternsError) && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">{t('ai.loadError')}</span>
        </div>
      )}

      {/* Gate + health summary */}
      {status && (
        <div className="ai-status-row">
          <div className={`ai-status-pill ${status.enabled ? 'on' : 'off'}`}>
            <Bot size={14} />
            {status.enabled ? t('ai.status.enabled') : t('ai.status.disabled')}
          </div>
          <div className={`ai-status-pill ${status.approvalEnabled ? 'gate-on' : 'gate-off'}`}>
            <Clock size={14} />
            {status.approvalEnabled ? t('ai.status.approvalGate') : t('ai.status.approvalOff')}
          </div>
          <div className={`ai-status-pill ${status.llmReachable ? 'on' : 'off'}`}>
            <Sparkles size={14} />
            <span className="ai-status-model">{status.llmModel}</span>
            {status.llmReachable ? t('ai.status.reachable') : t('ai.status.unreachable')}
          </div>
          <div className="ai-status-pill neutral">
            <span>
              {t('ai.status.pendingCount', { count: status.pendingApprovals })}
            </span>
            <span aria-hidden="true" className="ai-status-sep">
              ·
            </span>
            <span>{t('ai.status.patternCount', { count: status.patternCount })}</span>
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="ai-toolbar" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem', gap: '0.5rem' }}>
        <button className="btn-secondary" onClick={handleRefresh} disabled={loadingApprovals}>
          {loadingApprovals ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          {t('common.refresh')}
        </button>
        <button
          className="btn-primary"
          onClick={() => setShowAgentInput(!showAgentInput)}
          style={{ background: showAgentInput ? 'var(--primary-hover, #1da851)' : 'var(--primary)' }}
        >
          <Send size={16} />
          {t('ai.actions.agent')}
        </button>
      </div>

      {/* AI Agent Input */}
      {showAgentInput && (
        <div className="ai-agent-input" style={{
          background: 'var(--bg-card, #fff)', border: '1px solid var(--border, #e5e7eb)',
          borderRadius: 'var(--radius, 10px)', padding: '1rem', marginBottom: '1rem',
        }}>
          <h4 style={{ margin: '0 0 0.75rem', fontSize: '0.875rem', fontWeight: 700 }}>
            ✨ AI Agent — Send a message to someone
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <input
              type="text"
              placeholder="Enter phone number (e.g. 917439163739)"
              value={agentPhone}
              onChange={e => setAgentPhone(e.target.value)}
              style={{
                padding: '0.5rem 0.75rem', border: '1px solid var(--border, #e5e7eb)',
                borderRadius: 'var(--radius-sm, 6px)', fontSize: '0.875rem',
                fontFamily: 'inherit', color: 'var(--text-primary, #111827)',
                background: 'var(--bg-input, #fff)',
              }}
            />
            <textarea
              placeholder="Describe what message to send (e.g. Tell them we'll call tomorrow at 3pm)"
              value={agentPrompt}
              onChange={e => setAgentPrompt(e.target.value)}
              rows={3}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '0.5rem 0.75rem',
                border: '1px solid var(--border, #e5e7eb)', borderRadius: 'var(--radius-sm, 6px)',
                fontFamily: 'inherit', fontSize: '0.875rem',
                color: 'var(--text-primary, #111827)', background: 'var(--bg-input, #fff)',
                resize: 'vertical', minHeight: '3rem',
              }}
            />
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="btn-secondary" onClick={() => { setShowAgentInput(false); setAgentPrompt(''); setAgentPhone(''); }}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={handleAgentSend}
                disabled={agentMutation.isPending || !agentPrompt.trim() || !agentPhone.trim()}
              >
                {agentMutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                {t('ai.actions.sendViaAgent')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="ai-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'pending'}
          className={`ai-tab-btn ${tab === 'pending' ? 'active' : ''}`}
          onClick={() => setTab('pending')}
        >
          {t('ai.tabs.pending')}
          {pending.length > 0 && <span className="ai-tab-count">{pending.length}</span>}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'resolved'}
          className={`ai-tab-btn ${tab === 'resolved' ? 'active' : ''}`}
          onClick={() => setTab('resolved')}
        >
          {t('ai.tabs.resolved')}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'patterns'}
          className={`ai-tab-btn ${tab === 'patterns' ? 'active' : ''}`}
          onClick={() => setTab('patterns')}
        >
          {t('ai.tabs.patterns')}
          {patterns.length > 0 && <span className="ai-tab-count">{patterns.length}</span>}
        </button>
      </div>

      {/* Pending approvals */}
      {tab === 'pending' && (
        <div role="tabpanel">
          {pending.length === 0 ? (
            <div className="empty-table-state">
              <Bot size={48} strokeWidth={1} />
              <h3>{t('ai.empty.pendingTitle')}</h3>
              <p>{t('ai.empty.pendingDescription')}</p>
            </div>
          ) : (
            <div className="ai-card-list">
              {pending.map(item => (
                <div key={item.id} className="ai-approval-card">
                  <div className="ai-card-header">
                    <div className="ai-card-header-left">
                      <span className={`ai-kind-tag ${item.kind}`}>
                        {item.kind === 'agent' ? 'Agent' : item.kind === 'pattern' ? t('ai.kind.pattern') : t('ai.kind.draft')}
                      </span>
                      {item.kind === 'pattern' && item.confidence !== undefined && (
                        <span className="ai-confidence">
                          {Math.round(item.confidence * 100)}% {t('ai.kind.match')}
                        </span>
                      )}
                      {item.kind === 'agent' && item.targetPhone && (
                        <span className="ai-confidence" style={{ background: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6' }}>
                          📞 {item.targetPhone}
                        </span>
                      )}
                      {item.kind === 'agent' && (
                        <span className="ai-msg-summary" style={{ fontSize: '0.72rem', color: 'var(--text-secondary, #6b7280)' }}>
                          ⏱ {t('ai.actions.agentDelayHint')}
                        </span>
                      )}
                    </div>
                    <span className="ai-card-meta">
                      {item.sender} · {item.chatId}
                    </span>
                  </div>
                  <div className="ai-card-body">
                    <div className="ai-msg-block">
                      <span className="ai-msg-label">{t('ai.card.original')}</span>
                      <p className="ai-msg-text ai-msg-in">{item.originalMessage}</p>
                    </div>
                    <div className="ai-msg-block">
                      <span className="ai-msg-label">{t('ai.card.draft')}</span>
                      {editingId === item.id ? (
                        <textarea
                          style={{
                            width: '100%', boxSizing: 'border-box', marginTop: '0.25rem', padding: '0.5rem 0.625rem',
                            border: '1px solid var(--primary, #25d366)', borderRadius: 'var(--radius, 10px)',
                            fontFamily: 'inherit', fontSize: '0.875rem', color: 'var(--text-primary, #111827)',
                            background: 'var(--bg-input, #fff)', resize: 'vertical', minHeight: '3rem',
                          }}
                          value={editText}
                          onChange={e => setEditText(e.target.value)}
                          rows={3}
                        />
                      ) : (
                        <p className="ai-msg-text ai-msg-out">{item.customReply ?? item.draftReply}</p>
                      )}
                    </div>
                    {item.summary && (
                      <div className="ai-msg-block">
                        <span className="ai-msg-label">{t('ai.card.summary')}</span>
                        <p className="ai-msg-summary">{item.summary}</p>
                      </div>
                    )}
                  </div>
                  <div className="ai-card-footer">
                    <span className="ai-card-time">{formatWhen(item.createdAt)}</span>
                    <div className="ai-card-actions">
                      {editingId === item.id ? (
                        <>
                          <button
                            className="btn-primary"
                            onClick={() => handleEditSave(item)}
                            disabled={editMutation.isPending && editMutation.variables?.id === item.id}
                          >
                            {editMutation.isPending && editMutation.variables?.id === item.id ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : (
                              <Save size={16} />
                            )}
                            {t('ai.actions.saveDraft')}
                          </button>
                          <button className="btn-secondary" onClick={() => handleEditCancel()}>
                            <XSquare size={16} />
                            {t('ai.actions.cancelEdit')}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="btn-secondary"
                            onClick={() => handleEditStart(item)}
                            title={t('ai.actions.editDraft')}
                          >
                            <Edit3 size={16} />
                          </button>
                          <button
                            className="btn-danger-outline"
                            onClick={() => handleReject(item)}
                            disabled={rejectMutation.isPending && rejectMutation.variables === item.id}
                          >
                            {rejectMutation.isPending && rejectMutation.variables === item.id ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : (
                              <X size={16} />
                            )}
                            {t('ai.actions.reject')}
                          </button>
                          <button
                            className="btn-primary"
                            onClick={() => handleApprove(item)}
                            disabled={approveMutation.isPending && approveMutation.variables === item.id}
                          >
                            {approveMutation.isPending && approveMutation.variables === item.id ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : (
                              <Check size={16} />
                            )}
                            {t('ai.actions.approve')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Resolved history */}
      {tab === 'resolved' && (
        <div role="tabpanel">
          {resolved.length === 0 ? (
            <div className="empty-table-state">
              <Clock size={48} strokeWidth={1} />
              <h3>{t('ai.empty.resolvedTitle')}</h3>
              <p>{t('ai.empty.resolvedDescription')}</p>
            </div>
          ) : (
            <div className="ai-resolved-list">
              {resolved.map(item => (
                <div key={item.id} className="ai-resolved-row">
                  <span className={`status-badge ai-resolved-status ${item.status}`}>
                    {t(`ai.resolved.${item.status}`)}
                  </span>
                  <span className="ai-resolved-chat">{item.chatId}</span>
                  <span className="ai-resolved-snippet">{(item.customReply ?? item.draftReply).slice(0, 80)}</span>
                  {item.kind === 'agent' && item.sendAt && !item.sendError && Date.now() < new Date(item.sendAt).getTime() && (
                    <span className="ai-resolved-snippet" style={{ color: '#f59e0b' }}>
                      ⏳ {t('ai.actions.agentWillSend')}
                    </span>
                  )}
                  {item.kind === 'agent' && item.sendError && (
                    <span className="ai-resolved-snippet" style={{ color: '#ef4444' }} title={item.sendError}>
                      ⚠ {t('ai.actions.agentSendFailed')}: {String(item.sendError).slice(0, 60)}
                    </span>
                  )}
                  <span className="ai-card-time">{formatWhen(item.resolvedAt || item.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Learned patterns */}
      {tab === 'patterns' && (
        <div role="tabpanel">
          {patterns.length === 0 ? (
            <div className="empty-table-state">
              <BookMarked size={48} strokeWidth={1} />
              <h3>{t('ai.empty.patternsTitle')}</h3>
              <p>{t('ai.empty.patternsDescription')}</p>
            </div>
          ) : (
            <div className="ai-card-list">
              {patterns.map(pattern => (
                <div key={pattern.id} className="ai-pattern-card">
                  <div className="ai-card-header">
                    <span className="ai-kind-tag pattern">{t('ai.kind.pattern')}</span>
                    <span className="ai-pattern-uses">
                      {t('ai.patterns.uses', { count: pattern.uses })}
                    </span>
                    {canWrite && (
                      <button
                        className="icon-btn danger"
                        title={t('ai.actions.deletePattern')}
                        onClick={() => setDeleteTarget(pattern)}
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                  <div className="ai-card-body">
                    {pattern.keywords.length > 0 && (
                      <div className="ai-msg-block">
                        <span className="ai-msg-label">{t('ai.patterns.keywords')}</span>
                        <div className="ai-keyword-tags">
                          {pattern.keywords.slice(0, 10).map(kw => (
                            <span key={kw} className="ai-keyword-tag">
                              {kw}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="ai-msg-block">
                      <span className="ai-msg-label">{t('ai.patterns.reply')}</span>
                      <p className="ai-msg-text ai-msg-out">{pattern.reply}</p>
                    </div>
                    {pattern.summary && (
                      <div className="ai-msg-block">
                        <span className="ai-msg-label">{t('ai.card.summary')}</span>
                        <p className="ai-msg-summary">{pattern.summary}</p>
                      </div>
                    )}
                  </div>
                  <div className="ai-card-footer">
                    <span className="ai-card-time">{formatWhen(pattern.lastUsed)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {deleteTarget && (
        <Modal
          open
          onClose={() => setDeleteTarget(null)}
          title={t('ai.patterns.deleteTitle')}
          className="modal-sm"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={handleDeletePattern}>
                {t('common.delete')}
              </button>
            </>
          }
        >
          <p>{t('ai.patterns.deleteConfirm')}</p>
          <p className="ai-msg-text ai-msg-out">{deleteTarget.reply}</p>
        </Modal>
      )}
    </div>
  );
}
