export interface RegistrationData {
    username: string;
    email: string;
    password: string;
}

export type RegistrationFieldErrors = Partial<Record<keyof RegistrationData, string>>;

type ValidationResult = {data: RegistrationData; error?: never; fieldErrors?: never}
    | {data?: never; error: string; fieldErrors?: RegistrationFieldErrors};

export function validateRegistration(value: unknown): ValidationResult;
