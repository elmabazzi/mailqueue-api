import type { Request, Response } from 'express';

import {
  CreateEmailRequestSchema,
  EmailIdParamsSchema,
  ListEmailsQuerySchema,
} from '../../models/email.schemas.js';
import { toEmailJobDto } from '../../models/emailJob.model.js';
import type { EmailService } from '../../services/email.service.js';
import { parseRequest } from '../validation.js';

export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  /** POST /emails: queue an email. 202 Accepted = "received, will be processed later". */
  create = async (req: Request, res: Response): Promise<void> => {
    const input = parseRequest(CreateEmailRequestSchema, req.body, 'body');
    const job = await this.emailService.submit({
      toEmail: input.to,
      subject: input.subject,
      body: input.body,
    });
    res
      .status(202)
      .location(`/emails/${job.id}`)
      .json({ data: toEmailJobDto(job) });
  };

  /** GET /emails/:id: one email job and its current status. */
  getById = async (req: Request, res: Response): Promise<void> => {
    const { id } = parseRequest(EmailIdParamsSchema, req.params, 'params');
    const job = await this.emailService.getById(id);
    res.json({ data: toEmailJobDto(job) });
  };

  /** GET /emails?status=&limit=&offset=: newest first. */
  list = async (req: Request, res: Response): Promise<void> => {
    const query = parseRequest(ListEmailsQuerySchema, req.query, 'query');
    const page = await this.emailService.list(query);
    res.json({
      data: page.items.map(toEmailJobDto),
      pagination: { limit: query.limit, offset: query.offset, total: page.total },
    });
  };
}
