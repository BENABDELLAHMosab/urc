import {useEffect} from 'react';
import {useDispatch, useSelector} from 'react-redux';
import type {RootState, AppDispatch} from '../../app/store';
import {fetchRooms} from './roomsSlice';

export function useRooms(roomId?: number) {
    const dispatch = useDispatch<AppDispatch>();
    const auth = useSelector((state: RootState) => state.auth);
    const rooms = useSelector((state: RootState) => state.rooms);
    useEffect(() => {
        if (auth.status !== 'authenticated') return;
        const request = dispatch(fetchRooms());
        return () => request.abort();
    }, [auth, roomId, dispatch]);
    return {...rooms, retry: () => dispatch(fetchRooms())};
}
