import {configureStore} from "@reduxjs/toolkit";
import authReducer from "../features/auth/authSlice";
import usersReducer from "../features/users/usersSlice";

export const store = configureStore({
    //Ici, authReducer est le reducer global du slice, généré automatiquement par createSlice. Il sait traiter toutes les actions de ce slice.
    // c est pour cette raison que il est en singulier et dans le slice en pleural
    reducer: {
        auth: authReducer,
        users: usersReducer,
    },
});

// pour exporter le type ( pour le typescript)

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
