import {useEffect} from 'react';
import {useDispatch, useSelector, useStore} from 'react-redux';
import type {AppDispatch, RootState} from '../../app/store';
import {fetchUsers} from './usersSlice';

export function useUsers(enabled = true) {
    const dispatch = useDispatch<AppDispatch>();
    const store = useStore<RootState>();
    const user = useSelector((state: RootState) => state.auth.user);
    const users = useSelector((state: RootState) => state.users);

    useEffect(() => {
        if (!enabled || !user || store.getState().users.status === 'succeeded') return;
        const request = dispatch(fetchUsers());
        return () => request.abort();
    }, [enabled, user, dispatch, store]);

    return {...users, user, retry: () => dispatch(fetchUsers())};
}
