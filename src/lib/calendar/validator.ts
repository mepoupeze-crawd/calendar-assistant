/**
 * Calendar Assistant - Validation Engine (t3)
 * Validates ParsedEvent against business rules (João's decisions)
 * 
 * VALIDATION RULES (Confirmed 25/02/2026):
 * - Título: obrigatório (1-100 chars)
 * - Data: obrigatório (today to +365 days)
 * - Horário: obrigatório UNLESS all_day=true
 * - Participantes: opcional
 * - Ambiguidade temporal: bloqueia e pede clarificação
 */

import { ParsedEvent, ValidatedEvent, ParsedParticipant } from './types';

export interface ValidationResult {
  valid: boolean;
  status: 'valid' | 'invalid' | 'ambiguous' | 'clarification_needed';
  errors: string[];
  warnings: string[];
  clarificationRequest?: string;
  correctedEvent?: ValidatedEvent;
}

/**
 * Main validation entry point
 */
export function validateParsedEvent(parsed: ParsedEvent): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let clarificationRequest: string | undefined;

  // Step 1: Check parser status
  if (parsed.status === 'error') {
    return {
      valid: false,
      status: 'invalid',
      errors: [parsed.ambiguities?.[0] || 'Erro ao fazer parse do texto'],
      warnings: [],
    };
  }

  // Step 2: Detect ambiguities (block immediately)
  if (parsed.ambiguities && parsed.ambiguities.length > 0) {
    // Data inválida (ex: 30/02) é um erro, não apenas ambiguidade
    const invalidDateAmbiguities = parsed.ambiguities.filter(a => a.toLowerCase().includes('data inválida') || a.toLowerCase().includes('invalid date'));
    if (invalidDateAmbiguities.length > 0) {
      return {
        valid: false,
        status: 'invalid',
        errors: invalidDateAmbiguities,
        warnings: [],
      };
    }

    clarificationRequest = buildClarificationRequest(parsed.ambiguities);
    return {
      valid: false,
      status: 'ambiguous',
      errors: [],
      warnings: [],
      clarificationRequest,
    };
  }

  // Step 3: Validate required fields
  validateRequiredFields(parsed, errors);

  // Step 4: Validate field formats
  validateFieldFormats(parsed, errors, warnings);

  // Step 5: Validate logical consistency
  validateLogicalConsistency(parsed, errors, warnings);

  // If any errors, return invalid
  if (errors.length > 0) {
    clarificationRequest = buildClarificationFromErrors(errors);
    return {
      valid: false,
      status: 'invalid',
      errors,
      warnings,
      clarificationRequest,
    };
  }

  // Build corrected/validated event
  const correctedEvent = buildValidatedEvent(parsed);

  return {
    valid: true,
    status: 'valid',
    errors: [],
    warnings,
    correctedEvent,
  };
}

/**
 * Step 3: Validate required fields per business rules
 * - title: obrigatório
 * - start_date: obrigatório
 * - start_time: obrigatório UNLESS all_day
 */
function validateRequiredFields(parsed: ParsedEvent, errors: string[]): void {
  // Title
  if (!parsed.title || parsed.title.trim().length === 0) {
    errors.push('title_missing');
  }

  // Date
  if (!parsed.start_date) {
    errors.push('date_missing');
  }

  // Time (if not all_day)
  if (!parsed.all_day && !parsed.start_time) {
    errors.push('time_missing');
  }
}

/**
 * Step 4: Validate field formats
 */
function validateFieldFormats(
  parsed: ParsedEvent,
  errors: string[],
  warnings: string[]
): void {
  // Title length
  if (parsed.title && (parsed.title.length < 1 || parsed.title.length > 100)) {
    errors.push('title_length_invalid');
  }

  // Date format (YYYY-MM-DD)
  if (parsed.start_date && !isValidDateFormat(parsed.start_date)) {
    errors.push('date_format_invalid');
  }

  // Time format (HH:MM)
  if (parsed.start_time && !isValidTimeFormat(parsed.start_time)) {
    errors.push('time_format_invalid');
  }
  if (parsed.end_time && !isValidTimeFormat(parsed.end_time)) {
    errors.push('end_time_format_invalid');
  }

  // Date range (today to +365 days)
  if (parsed.start_date) {
    const dateValidation = validateDateRange(parsed.start_date);
    if (!dateValidation.valid) {
      if (dateValidation.retroactive) {
        warnings.push('date_retroactive_same_day');
      } else if (dateValidation.tooFar) {
        errors.push('date_too_far_future');
      } else {
        errors.push('date_out_of_range');
      }
    }
  }
}

/**
 * Step 5: Validate logical consistency
 */
function validateLogicalConsistency(
  parsed: ParsedEvent,
  errors: string[],
  warnings: string[]
): void {
  // If both times present, end_time > start_time
  if (parsed.start_time && parsed.end_time) {
    if (!isTimeAfter(parsed.end_time, parsed.start_time)) {
      errors.push('time_end_before_start');
    }
  }

  // Duration should match times if present
  if (
    parsed.start_time &&
    parsed.end_time &&
    parsed.duration_minutes &&
    !isDurationConsistent(parsed.start_time, parsed.end_time, parsed.duration_minutes)
  ) {
    warnings.push('duration_mismatch_times');
  }
}

/**
 * Helper: Build clarification request from ambiguities
 */
function buildClarificationRequest(ambiguities: string[]): string {
  const msgs = ambiguities.map((amb) => {
    if (amb.includes('hora não específica')) {
      return 'horário exato (ex: 14:30)?';
    }
    if (amb.includes('data vaga')) {
      return 'data específica (ex: 25/02)?';
    }
    return amb;
  });

  return `Preciso de mais informações: ${msgs.join(', ')}\n\nPode detalhar?`;
}

/**
 * Helper: Build clarification request from validation errors
 */
function buildClarificationFromErrors(errors: string[]): string {
  const errorMessages: { [key: string]: string } = {
    title_missing: 'Qual é o título do evento?',
    date_missing: 'Que dia será? (ex: 25/02)',
    time_missing: 'Que horário? (ex: 14:30)',
    title_length_invalid: 'Título muito curto ou muito longo (máx 100 chars)',
    date_format_invalid: 'Data em formato inválido',
    time_format_invalid: 'Horário em formato inválido (use HH:MM)',
    end_time_format_invalid: 'Hora final em formato inválido (use HH:MM)',
    date_too_far_future: 'Data muito distante (máx 1 ano no futuro)',
    date_out_of_range: 'Data inválida',
    time_end_before_start: 'Hora final deve ser depois da hora inicial',
  };

  const msgs = errors
    .map((e) => errorMessages[e] || e)
    .filter((m) => m);

  return `❌ Evento inválido:\n${msgs.map((m) => `• ${m}`).join('\n')}\n\nPode revisar?`;
}

/**
 * Helper: Build ValidatedEvent from ParsedEvent
 */
function buildValidatedEvent(parsed: ParsedEvent): ValidatedEvent {
  return {
    title: parsed.title!,
    start_date: parsed.start_date!,
    start_time: parsed.all_day ? null : parsed.start_time,
    end_time: parsed.all_day ? null : parsed.end_time,
    duration_minutes: parsed.duration_minutes,
    all_day: parsed.all_day,
    participants: parsed.participants || [],
    description: parsed.description,
    location: parsed.location,
  };
}

/**
 * Helpers: Format validation
 */
function isValidDateFormat(date: string): boolean {
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(date)) return false;

  const [year, month, day] = date.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  // Validate actual calendar date (catches 30/02, 31/04, etc.)
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) {
    return false;
  }

  return true;
}

function isValidTimeFormat(time: string): boolean {
  const pattern = /^\d{2}:\d{2}$/;
  if (!pattern.test(time)) return false;

  const [hour, minute] = time.split(':').map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;

  return true;
}

function validateDateRange(date: string): {
  valid: boolean;
  retroactive?: boolean;
  tooFar?: boolean;
} {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const eventDate = new Date(date);
  const maxDate = new Date(today);
  maxDate.setFullYear(maxDate.getFullYear() + 1);

  // Check if retroactive (before today)
  if (eventDate < today && eventDate.toDateString() !== today.toDateString()) {
    return { valid: false, retroactive: true };
  }

  // Check if too far (more than 1 year)
  if (eventDate > maxDate) {
    return { valid: false, tooFar: true };
  }

  return { valid: true };
}

function isTimeAfter(endTime: string, startTime: string): boolean {
  const [endHour, endMin] = endTime.split(':').map(Number);
  const [startHour, startMin] = startTime.split(':').map(Number);

  const endMinutes = endHour * 60 + endMin;
  const startMinutes = startHour * 60 + startMin;

  return endMinutes > startMinutes;
}

function isDurationConsistent(
  startTime: string,
  endTime: string,
  durationMinutes: number
): boolean {
  const [startHour, startMin] = startTime.split(':').map(Number);
  const [endHour, endMin] = endTime.split(':').map(Number);

  const calculatedDuration = (endHour * 60 + endMin) - (startHour * 60 + startMin);

  // Allow 5 min tolerance
  return Math.abs(calculatedDuration - durationMinutes) <= 5;
}
