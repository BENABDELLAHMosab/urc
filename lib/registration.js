import isEmail from 'validator/lib/isEmail.js';

export function validateRegistration(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {error: "Les trois champs sont obligatoires."};
    }
    const input = value;
    if (typeof input.username !== 'string' || typeof input.email !== 'string'
        || typeof input.password !== 'string') {
        return {error: "Les trois champs sont obligatoires."};
    }
    const username = input.username.trim();
    const email = input.email.trim();
    const password = input.password;
    const fieldErrors = {};
    if (!/^[A-Za-z0-9_.-]{3,50}$/.test(username)) {
        fieldErrors.username = "Le nom doit contenir 3 à 50 lettres, chiffres, points, tirets ou underscores.";
    }
    // Contrôle syntaxique uniquement : aucune recherche DNS ni vérification de boîte.
    if (email.length > 255 || !isEmail(email, {allow_display_name: false, require_tld: true})) {
        fieldErrors.email = "Saisissez un email valide (ex. : prenom@exemple.fr), de 255 caractères maximum.";
    }
    if (password.length < 12 || password.length > 128) {
        fieldErrors.password = "Le mot de passe doit contenir entre 12 et 128 caractères.";
    }
    if (Object.keys(fieldErrors).length > 0) {
        return {error: Object.values(fieldErrors)[0], fieldErrors};
    }
    return {data: {username, email, password}};
}
