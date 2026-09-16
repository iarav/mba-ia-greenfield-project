import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedException extends DomainException {
  constructor() {
    super(
      'VIDEO_NOT_OWNED',
      403,
      'Video does not belong to the authenticated channel',
    );
  }
}

export class VideoNotDraftException extends DomainException {
  constructor() {
    super('VIDEO_NOT_DRAFT', 409, 'Video is not in draft status');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for streaming');
  }
}

export class StorageException extends DomainException {
  constructor(message: string) {
    super('STORAGE_ERROR', 502, message);
  }
}
