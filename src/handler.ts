export interface IMailHeaderItem {
  key: string;
  value: string;
}

export interface IMailCommandItem {
  command: string;
  data: string;
}

export interface IMailInformation {
  messageId: string;
  headers: IMailHeaderItem[];
  commands: IMailCommandItem[];
}

export interface IGeneratedMailTrackerHtml {
  html: string;
}

export interface IGeneratedMailTrackerImage {
  imageSrc: string;
  imageStyles?: Record<string, string>;
  imageAlt?: string;
}

export type IGeneratedMailTracker = IGeneratedMailTrackerHtml | IGeneratedMailTrackerImage;

export type HandlerType = (info: IMailInformation) => Promise<IGeneratedMailTracker> | IGeneratedMailTracker;
