import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cloudRepository, demoRepository, supabase } from './repository.js';

// Keep asynchronous results inside the identity/workspace that requested them.
export function useErpSession(useCloud) {
  const [session, setSession] = useState(null),
    [authLoading, setAuthLoading] = useState(useCloud);
  const [workspaces, setWorkspaces] = useState([]),
    [chosen, setChosen] = useState(null),
    [membershipsLoading, setMembershipsLoading] = useState(useCloud);
  const [cloudError, setCloudError] = useState(''),
    [recovery, setRecovery] = useState(false),
    [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [data, setData] = useState(null),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState('');
  const epoch = useRef(0),
    identity = useRef(null),
    request = useRef(0),
    membershipRequest = useRef(0),
    mounted = useRef(true);
  const localRepo = useMemo(() => (useCloud ? null : demoRepository()), [useCloud]);
  const repo = useMemo(
    () =>
      useCloud ? (chosen ? cloudRepository(chosen.workspaces, chosen.role) : null) : localRepo,
    [useCloud, chosen, localRepo],
  );
  const activeRepo = useRef(repo);
  activeRepo.current = repo;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);

  useEffect(() => {
    if (!useCloud || !supabase) {
      setAuthLoading(false);
      setMembershipsLoading(false);
      return;
    }
    let alive = true,
      authEvents = 0;
    setAuthLoading(true);
    function apply(next) {
      const nextId = next?.user?.id || null;
      if (identity.current !== nextId) {
        identity.current = nextId;
        epoch.current++;
        request.current++;
        membershipRequest.current++;
        setChosen(null);
        setWorkspaces([]);
        setData(null);
        setCloudError('');
        setLoadError('');
        setRecovery(false);
        setMembershipsLoading(Boolean(nextId));
      }
      setSession(next);
      setAuthLoading(false);
    }
    const ticket = authEvents;
    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!alive || ticket !== authEvents) return;
        if (error) {
          setCloudError(error.message);
          setAuthLoading(false);
          return;
        }
        apply(data.session);
      })
      .catch((error) => {
        if (alive && ticket === authEvents) {
          setCloudError(error.message);
          setAuthLoading(false);
        }
      });
    const { data: listener } = supabase.auth.onAuthStateChange((event, next) => {
      if (!alive) return;
      authEvents++;
      apply(next);
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
    });
    return () => {
      alive = false;
      listener.subscription.unsubscribe();
    };
  }, [useCloud]);

  const refreshMemberships = useCallback(async () => {
    if (!useCloud || !session?.user?.id) return [];
    const userId = session.user.id,
      version = epoch.current,
      ticket = ++membershipRequest.current;
    setMembershipsLoading(true);
    setCloudError('');
    try {
      const { data: rows, error } = await supabase
        .from('workspace_members')
        .select('workspace_id,role,workspaces(id,name)')
        .order('workspace_id');
      if (error) throw error;
      if (
        !mounted.current ||
        version !== epoch.current ||
        identity.current !== userId ||
        ticket !== membershipRequest.current
      )
        return [];
      const memberships = (rows || []).filter((row) => row.workspaces);
      setWorkspaces(memberships);
      setChosen((previous) => {
        const next =
          memberships.find((row) => row.workspace_id === previous?.workspace_id) ||
          memberships[0] ||
          null;
        if (
          next &&
          previous &&
          next.workspace_id === previous.workspace_id &&
          next.role === previous.role &&
          next.workspaces.name === previous.workspaces.name
        )
          return previous;
        return next;
      });
      return memberships;
    } catch (error) {
      if (mounted.current && version === epoch.current && ticket === membershipRequest.current)
        setCloudError(error.message);
      throw error;
    } finally {
      if (mounted.current && version === epoch.current && ticket === membershipRequest.current)
        setMembershipsLoading(false);
    }
  }, [useCloud, session?.user?.id]);
  useEffect(() => {
    refreshMemberships().catch(() => {});
  }, [refreshMemberships]);
  useEffect(() => {
    if (!useCloud || !session?.user?.id) return;
    const focused = () => {
      refreshMemberships().catch(() => {});
    };
    window.addEventListener('focus', focused);
    return () => window.removeEventListener('focus', focused);
  }, [useCloud, session?.user?.id, refreshMemberships]);

  const refresh = useCallback(async () => {
    if (!repo) return false;
    const version = epoch.current,
      ticket = ++request.current;
    setLoadError('');
    try {
      const next = await repo.load();
      if (
        !mounted.current ||
        version !== epoch.current ||
        activeRepo.current !== repo ||
        ticket !== request.current
      )
        return false;
      setData(next);
      return true;
    } catch (error) {
      if (
        mounted.current &&
        version === epoch.current &&
        activeRepo.current === repo &&
        ticket === request.current
      ) {
        setLoadError(error.message);
        throw error;
      }
      return false;
    }
  }, [repo]);
  useEffect(() => {
    let alive = true;
    setData(null);
    setLoading(Boolean(repo));
    setLoadError('');
    if (repo)
      refresh()
        .catch(() => {})
        .finally(() => {
          if (alive) setLoading(false);
        });
    return () => {
      alive = false;
    };
  }, [repo, refresh]);

  async function bootstrap() {
    if (bootstrapBusy) return;
    const version = epoch.current;
    setBootstrapBusy(true);
    setCloudError('');
    try {
      const { error } = await supabase.rpc('bootstrap_workspace', { p_name: 'ChiDi Shop' });
      if (error) throw error;
      if (version === epoch.current) await refreshMemberships();
    } catch (error) {
      if (version === epoch.current) setCloudError(error.message);
    } finally {
      if (mounted.current) setBootstrapBusy(false);
    }
  }
  function chooseWorkspace(id) {
    const next = workspaces.find((w) => w.workspace_id === id);
    if (!next || next.workspace_id === chosen?.workspace_id) return;
    request.current++;
    setData(null);
    setLoadError('');
    setChosen(next);
    setLoading(true);
  }
  return {
    session,
    authLoading,
    recovery,
    setRecovery,
    workspaces,
    chosen,
    chooseWorkspace,
    membershipsLoading,
    refreshMemberships,
    cloudError,
    data,
    loading,
    loadError,
    setLoadError,
    repo,
    refresh,
    bootstrap,
    bootstrapBusy,
    contextKey: `${useCloud ? 'cloud' : 'demo'}:${session?.user?.id || ''}:${chosen?.workspace_id || ''}`,
  };
}
